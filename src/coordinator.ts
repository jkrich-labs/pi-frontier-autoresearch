import { isDeepStrictEqual } from "node:util";

import type {
  Clock,
  EvaluatorAdapter,
  GitWorkspacePort,
  PolicyReviewOutcome,
  PolicyReviewerAdapter,
  ProcessExecutor,
  ProcessGroupIdentity,
  StoreAdapter,
  WorkerAdapter,
  WorkerMarker,
} from "./adapters.ts";
import { CandidateCreator, WorkerLaunchPreventedError } from "./candidate.ts";
import type {
  Assignment,
  BaselineRecord,
  Evaluation,
  NodeRecord,
  PolicyReviewAssignment,
  PolicyReviewTrigger,
  RunEvent,
  RunEventDataMap,
  RunEventType,
  RunSpec,
  RunState,
} from "./contracts.ts";
import { FrontierController, type FrontierEvent } from "./frontier.ts";
import { NodeProcessExecutor } from "./process.ts";
import { RunConfigurator, type ConfiguredRun } from "./configurator.ts";
import { PolicyReviewer } from "./policy-reviewer.ts";
import {
  initialPolicyVersion,
  restoredPolicyVersion,
  validatePolicyProposal,
} from "./policy-tuning.ts";

export interface RunCoordinatorDependencies {
  store: StoreAdapter;
  workspace: GitWorkspacePort;
  worker: WorkerAdapter;
  evaluator: EvaluatorAdapter;
  clock: Clock;
  /** The executor that owns Pi worker process groups. */
  processExecutor?: ProcessExecutor;
  configurator?: Pick<RunConfigurator, "configure">;
  /** Fresh, submit-only worker used only when policyTuning.enabled is true. */
  policyReviewer?: PolicyReviewerAdapter;
}

interface FrontierProjection {
  history: FrontierEvent[];
  pendingTransition?: Extract<FrontierEvent, { type: "evaluation-recorded" }>;
  persistedTransition?: Extract<FrontierEvent, { type: "evaluation-recorded" }>;
  pendingNode?: NodeRecord;
}

type LoopAction = "continue" | "seed" | "review" | "return";

const POLICY_REVIEW_SIGNAL_WINDOW = 3;
const POLICY_REVIEW_MIN_EXPERIMENTS_BETWEEN_REVIEWS = 3;

interface ActiveWorker {
  assignment: Assignment;
  parent: NodeRecord;
  donor?: NodeRecord;
  abort: AbortController;
}

class UnconfirmedWorkerTerminationError extends Error {
  constructor(processGroupId: number) {
    super(`Could not confirm owned process group ${processGroupId} has exited`);
    this.name = "UnconfirmedWorkerTerminationError";
  }
}

class CoordinatorDisposedForRecoveryError extends Error {
  constructor() {
    super("Coordinator was disposed for recovery");
    this.name = "CoordinatorDisposedForRecoveryError";
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Never copy untrusted reviewer diagnostics into the durable event log. */
function policyReviewFinishedReason(outcome: PolicyReviewOutcome): string {
  switch (outcome.status) {
    case "proposed": return "Policy reviewer submitted a structured proposal.";
    case "failed": return "Policy reviewer failed.";
    case "timed-out": return "Policy reviewer timed out.";
    case "cancelled": return "Policy reviewer cancelled.";
  }
}

function at(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function initialState(spec: RunSpec, baseline: BaselineRecord, index: number): RunState {
  const activePolicy = initialPolicyVersion(spec.frontierPolicy);
  return {
    spec,
    status: "configured",
    baseline,
    nodes: {},
    frontier: [],
    budgetUsage: { experiments: 0, wallTimeMs: 0, reportedCostUsd: 0 },
    policyVersion: 1,
    activePolicy,
    policyHistory: [activePolicy],
    lastEventIndex: index,
    latestDecision: "Run configured; use /autoresearch start to begin experiments.",
  };
}

function baselineEvaluation(spec: RunSpec, baseline: BaselineRecord): Evaluation {
  return {
    nodeId: "baseline",
    samples: baseline.samples,
    summaries: baseline.summaries,
    guards: [{ name: "baseline", status: "passed" }],
    protectedPathsIntact: true,
    scopeValid: true,
    confirmationAttempted: false,
    confirmed: true,
    reason: "baseline calibrated during configuration",
  };
}

/**
 * Coordinates one durable, sequential experiment loop. Event history is authoritative;
 * snapshots are rebuilt after every event only to make status reads cheap.
 */
export class RunCoordinator {
  readonly #store: StoreAdapter;
  readonly #workspace: GitWorkspacePort;
  readonly #worker: WorkerAdapter;
  readonly #evaluator: EvaluatorAdapter;
  readonly #clock: Clock;
  readonly #process: ProcessExecutor;
  readonly #configurator: Pick<RunConfigurator, "configure">;
  readonly #policyReviewer: PolicyReviewerAdapter;
  readonly #creator: CandidateCreator;

  #state: RunState | undefined;
  #events: RunEvent[] = [];
  #wallStartedAt: number | undefined;
  #loop: Promise<void> | undefined;
  #workerAbort: AbortController | undefined;
  #workerGroup: ProcessGroupIdentity | undefined;
  /** Passive post-exit observation; it must never satisfy an active stop request. */
  #workerPassiveExitWait: Promise<boolean> | undefined;
  /** Concurrent stops may share an active termination, never a passive wait. */
  #workerActiveTermination: Promise<boolean> | undefined;
  #policyReviewAbort: AbortController | undefined;
  #policyReviewGroup: ProcessGroupIdentity | undefined;
  #disposedForRecovery = false;
  #clearing = false;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(dependencies: RunCoordinatorDependencies) {
    this.#store = dependencies.store;
    this.#workspace = dependencies.workspace;
    this.#worker = dependencies.worker;
    this.#evaluator = dependencies.evaluator;
    this.#clock = dependencies.clock;
    this.#process = dependencies.processExecutor ?? new NodeProcessExecutor(dependencies.clock);
    this.#configurator = dependencies.configurator ?? new RunConfigurator({
      commandExecutor: this.#process,
      store: this.#store,
      clock: this.#clock,
    });
    this.#policyReviewer = dependencies.policyReviewer ?? new PolicyReviewer({ processExecutor: this.#process });
    this.#creator = new CandidateCreator(this.#workspace, this.#worker);
  }

  async configure(input: unknown, signal?: AbortSignal): Promise<ConfiguredRun> {
    return await this.#exclusive(async () => {
      if (this.#clearing) throw new Error("Cannot configure while the current run is being cleared.");
      if (this.#loop) throw new Error("Stop the active run before configuring another run.");
      const existing = await this.#store.load();
      const hasArtifacts = await this.#store.hasRunArtifacts();
      if (existing.events.length > 0 || existing.snapshot || hasArtifacts === true) {
        throw new Error("Durable run state already exists; use /autoresearch clear before configuring another run.");
      }
      const configured = await this.#configurator.configure(input, signal);
      await this.#loadUnlocked(true);
      return configured;
    });
  }

  /** Start a configured run or resume a paused run without blocking the command handler. */
  async start(): Promise<RunState> {
    return await this.#exclusive(async () => {
      await this.#loadUnlocked();
      return await this.#startUnlocked();
    });
  }

  async pause(): Promise<RunState> {
    const loop = await this.#exclusive(async () => {
      await this.#loadUnlocked();
      const state = this.#requireState();
      if (state.status === "paused") return undefined;
      if (state.status !== "running" && state.status !== "pausing") {
        throw new Error(`Cannot pause a run that is ${state.status}.`);
      }
      if (state.status === "running") await this.#appendUnlocked("pause-requested", {});
      return { loop: this.#loop };
    });
    // Do not hold the lifecycle queue while waiting: the loop must append its
    // experiment boundary and run-paused event through that same queue.
    if (loop?.loop) await loop.loop;
    return this.status();
  }

  async resume(): Promise<RunState> {
    return await this.#exclusive(async () => {
      await this.#loadUnlocked();
      if (this.#requireState().status !== "paused") {
        throw new Error(`Cannot resume a run that is ${this.#requireState().status}.`);
      }
      return await this.#startUnlocked();
    });
  }

  /** Restore a prior immutable policy as a new version; history is never rewritten. */
  async rollbackPolicy(restoredVersion: number): Promise<RunState> {
    return await this.#exclusive(async () => {
      await this.#loadUnlocked();
      const state = this.#requireState();
      if (state.activeAssignment || state.activePolicyReview) {
        throw new Error("Policy rollback requires an experiment boundary.");
      }
      const source = state.policyHistory.find((policy) => policy.version === restoredVersion);
      if (!source) throw new Error(`Policy version ${restoredVersion} is not available for rollback.`);
      const policy = restoredPolicyVersion(source, state.activePolicy.version + 1);
      await this.#appendUnlocked("policy-rolled-back", {
        version: policy.version,
        previousVersion: state.activePolicy.version,
        restoredVersion,
        policy,
      });
      return this.#statusUnlocked();
    });
  }

  async stop(reason = "Stopped by user."): Promise<RunState> {
    const request = await this.#exclusive(async () => {
      await this.#loadUnlocked();
      const state = this.#requireState();
      if (["stopped", "completed", "failed"].includes(state.status)) {
        return { loop: undefined, group: undefined, alreadyTerminal: true };
      }
      if (state.status !== "stopping") await this.#appendUnlocked("stop-requested", { reason });
      this.#workerAbort?.abort(new Error(reason));
      this.#policyReviewAbort?.abort(new Error(reason));
      return { loop: this.#loop, group: this.#workerGroup ?? this.#policyReviewGroup, alreadyTerminal: false };
    });
    if (request.group !== undefined) await this.#terminateOwnedGroup(request.group);
    if (request.loop) await request.loop;
    else if (!request.alreadyTerminal) {
      await this.#exclusive(async () => {
        if (this.#requireState().status === "stopping") {
          await this.#appendUnlocked("run-stopped", { reason });
        }
      });
    }
    return this.status();
  }

  /**
   * Model coordinator/session death in an embedding host without touching its worker.
   * A fresh coordinator must recover the durable marker; this instance will make no
   * further lifecycle writes after its in-flight worker settles.
   */
  async disposeForRecovery(): Promise<void> {
    // Deliberately bypass the lifecycle queue: this models a controller process
    // disappearing while an adapter call is blocked. In-flight code checks this flag
    // before making any later durable write.
    this.#disposedForRecovery = true;
  }

  /** Clear owned processes, worktrees, refs, and state only after explicit confirmation. */
  async clear(confirmed = false): Promise<void> {
    if (!confirmed) throw new Error("Clear requires confirmation.");
    if (this.#clearing) throw new Error("A clear is already in progress.");
    // Set this before the first await so a racing start/resume cannot launch work.
    this.#clearing = true;
    const refused = () => new Error(
      "Clear refused because worker ownership could not be confirmed; durable state was preserved.",
    );
    try {
      const request = await this.#exclusive(async () => {
        const loaded = await this.#store.load();
        const hasReplayableState = loaded.events.length > 0 || loaded.snapshot !== undefined;
        // StoreAdapter's mandatory inspection distinguishes a truly empty store
        // from a crashed claim, partial state, or durable worker marker.
        const hasArtifacts = hasReplayableState || await this.#store.hasRunArtifacts();
        if (!hasArtifacts) {
          this.#state = undefined;
          this.#events = [];
          this.#wallStartedAt = undefined;
          return { alreadyEmpty: true, loop: undefined, group: undefined };
        }

        if (hasReplayableState) {
          await this.#loadUnlocked(true);
          const state = this.#requireState();
          if (["running", "pausing"].includes(state.status)) {
            await this.#appendUnlocked("stop-requested", { reason: "Run cleared by user." });
          }
        } else {
          // A directory without replayable state is a durable, fail-closed partial
          // claim. It is clearable only through the same ownership and cleanup path.
          this.#state = undefined;
          this.#events = [];
          this.#wallStartedAt = undefined;
        }
        this.#workerAbort?.abort(new Error("Run cleared by user."));
        this.#policyReviewAbort?.abort(new Error("Run cleared by user."));
        return {
          alreadyEmpty: false,
          loop: this.#loop,
          group: this.#workerGroup ?? this.#policyReviewGroup,
        };
      });
      if (request.alreadyEmpty) return;
      if (request.group && !await this.#terminateOwnedGroup(request.group)) throw refused();
      if (request.loop) await request.loop;

      await this.#exclusive(async () => {
        const marker = await this.#store.readWorkerMarker();
        if (marker && (!this.#state || !await this.#recoverWorkerOwnershipUnlocked(marker))) throw refused();
        // Process ownership is confirmed before any worktree path or immutable ref
        // can be touched. Unlike recover(), clear never reconciles or relaunches work.
        await this.#workspace.recover();
        if (!this.#workspace.clearRunRefs) {
          throw new Error("Clear refused because namespaced Git ref cleanup is unavailable; durable state was preserved.");
        }
        await this.#workspace.clearRunRefs();
        await this.#store.clear();
        this.#state = undefined;
        this.#events = [];
        this.#wallStartedAt = undefined;
      });
    } finally {
      this.#clearing = false;
    }
  }

  /**
   * Rebuild state from JSONL and recover only after an owned worker has been
   * proved dead. A marker without a process group is intentionally fail-closed.
   */
  async recover(): Promise<RunState> {
    return await this.#exclusive(async () => {
      if (this.#clearing) throw new Error("Cannot recover while the current run is being cleared.");
      // An in-process loop already owns its worker and state. Reloading underneath it
      // would race its event append sequence; recovery is only for a fresh coordinator.
      if (this.#loop) return this.#statusUnlocked();
      await this.#loadUnlocked(true);
      const marker = await this.#store.readWorkerMarker();
      if (marker && !await this.#recoverWorkerOwnershipUnlocked(marker)) return this.#statusUnlocked();

      // This is deliberately after marker ownership is terminated and confirmed. A
      // potentially live worker must never race worktree cleanup or materialisation.
      await this.#workspace.recover();
      if (marker?.kind === "policy-review" || (!marker && this.#requireState().activePolicyReview)) {
        await this.#reconcileActivePolicyReviewUnlocked(marker);
      } else {
        await this.#reconcileActiveAssignmentUnlocked(marker);
      }
      if (marker && (marker.kind === "policy-review"
        ? this.#policyReviewBoundaryRecorded(marker.reviewId ?? marker.experimentId)
        : this.#markerBoundariesRecorded(marker.experimentId))) {
        await this.#store.clearWorkerMarker();
      }
      if (["running", "pausing", "stopping"].includes(this.#requireState().status)) this.#launchUnlocked();
      return this.#statusUnlocked();
    });
  }

  /** Return a copy so callers can only observe public coordinator state. */
  status(): RunState {
    return this.#statusUnlocked();
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release: (() => void) | undefined;
    this.#mutationTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await operation();
    } finally {
      release!();
    }
  }

  async #startUnlocked(): Promise<RunState> {
    if (this.#clearing) throw new Error("Cannot start work while the current run is being cleared.");
    const state = this.#requireState();
    if (state.status !== "configured" && state.status !== "paused") {
      throw new Error(`Cannot start a run that is ${state.status}.`);
    }
    if (!this.#events.some((event) => event.type === "frontier-policy-recorded")) {
      await this.#appendUnlocked("frontier-policy-recorded", { policy: this.#requireState().activePolicy });
    }
    await this.#appendUnlocked("run-started", {});
    this.#launchUnlocked();
    return this.#statusUnlocked();
  }

  async #loadUnlocked(force = false): Promise<void> {
    if (this.#state && !force) return;
    const loaded = await this.#store.load();
    if (loaded.events.length === 0) {
      if (loaded.snapshot) {
        this.#state = structuredClone(loaded.snapshot);
        this.#events = [];
        this.#wallStartedAt = undefined;
        return;
      }
      throw new Error("No configured frontier autoresearch run was found.");
    }
    this.#events = [...loaded.events];
    this.#state = this.#rebuild(this.#events);
  }

  #requireState(): RunState {
    if (!this.#state) throw new Error("No configured frontier autoresearch run was found.");
    return this.#state;
  }

  #statusUnlocked(): RunState {
    const state = structuredClone(this.#requireState());
    state.budgetUsage.wallTimeMs = this.#wallTimeNow();
    return state;
  }

  #controller(): FrontierController {
    const spec = this.#requireState().spec;
    const primary = spec.metrics.find((metric) => metric.name === spec.primaryMetric);
    if (!primary) throw new Error(`Primary metric ${spec.primaryMetric} is not configured.`);
    return new FrontierController({
      primaryMetric: spec.primaryMetric,
      primaryDirection: primary.direction,
      policy: spec.frontierPolicy,
      policyVersions: this.#requireState().policyHistory,
    });
  }

  #rebuild(events: readonly RunEvent[]): RunState {
    this.#wallStartedAt = undefined;
    let state: RunState | undefined;
    let previousIndex = 0;
    for (const event of events) {
      if (!Number.isInteger(event.index) || event.index !== previousIndex + 1) {
        throw new Error("Run event indexes must increase monotonically without gaps.");
      }
      previousIndex = event.index;
      if (event.type === "run-configured") {
        if (state) throw new Error("Run history contains more than one configuration event.");
        state = initialState(event.data.spec, event.data.baseline, event.index);
        continue;
      }
      if (!state) throw new Error("Run history must begin with a configuration event.");
      this.#apply(state, event);
    }
    if (!state) throw new Error("Run history has no configuration event.");
    return state;
  }

  #apply(state: RunState, event: RunEvent): void {
    const timestamp = Date.parse(event.at);
    const eventTime = Number.isFinite(timestamp) ? timestamp : this.#clock.now();
    switch (event.type) {
      case "run-started":
        state.status = "running";
        this.#wallStartedAt = eventTime;
        break;
      case "pause-requested":
        state.status = "pausing";
        break;
      case "run-paused":
        this.#sealWallTime(state, eventTime);
        state.status = "paused";
        break;
      case "stop-requested":
        state.status = "stopping";
        state.latestDecision = event.data.reason;
        break;
      case "run-stopped":
        this.#sealWallTime(state, eventTime);
        state.status = "stopped";
        state.activeAssignment = undefined;
        state.latestDecision = event.data.reason;
        break;
      case "assignment-recorded":
        if (state.activePolicyReview) throw new Error("Cannot assign a candidate while a policy review is active.");
        if (event.data.assignment.policyVersion !== state.activePolicy.version) {
          throw new Error(`Assignment ${event.data.assignment.experimentId} does not use the active policy version.`);
        }
        state.activeAssignment = event.data.assignment;
        state.latestDecision = `Assigned ${event.data.assignment.experimentId}.`;
        break;
      case "worker-finished":
        state.budgetUsage.reportedCostUsd += event.data.reportedCostUsd ?? 0;
        break;
      case "node-recorded":
        state.nodes = { ...state.nodes, [event.data.node.id]: event.data.node };
        break;
      case "evaluation-recorded": {
        const node = state.nodes[event.data.evaluation.nodeId];
        if (node) {
          state.nodes = {
            ...state.nodes,
            [node.id]: {
              ...node,
              metricSamples: event.data.evaluation.samples,
              guardResults: event.data.evaluation.guards,
            },
          };
        }
        break;
      }
      case "frontier-updated":
        state.frontier = event.data.slots;
        state.latestDecision = event.data.reason;
        break;
      case "experiment-finished": {
        const node = state.nodes[event.data.nodeId];
        if (node) {
          state.nodes = { ...state.nodes, [node.id]: { ...node, outcome: event.data.outcome } };
        }
        if (node?.operator !== "baseline") state.budgetUsage.experiments += 1;
        state.activeAssignment = undefined;
        break;
      }
      case "run-completed":
        this.#sealWallTime(state, eventTime);
        state.status = "completed";
        state.latestDecision = event.data.reason;
        break;
      case "run-failed":
        this.#sealWallTime(state, eventTime);
        state.status = "failed";
        state.latestDecision = event.data.reason;
        break;
      case "frontier-policy-recorded":
        if (!isDeepStrictEqual(event.data.policy, state.activePolicy)) {
          throw new Error("Recorded initial policy does not match the configured frontier policy.");
        }
        break;
      case "policy-review-recorded":
        if (state.activeAssignment || state.activePolicyReview) {
          throw new Error("Policy review must begin at an experiment boundary.");
        }
        if (event.data.review.policyVersion !== state.activePolicy.version) {
          throw new Error("Policy review does not use the active policy version.");
        }
        state.activePolicyReview = event.data.review;
        state.latestDecision = `Reviewing policy after ${event.data.review.trigger}.`;
        break;
      case "policy-review-finished":
        if (!state.activePolicyReview || state.activePolicyReview.reviewId !== event.data.reviewId) {
          throw new Error("Policy review completion does not match an active review.");
        }
        state.activePolicyReview = undefined;
        break;
      case "policy-proposed": {
        const finished = this.#events.find((candidate) => candidate.index === event.index - 1);
        const review = this.#events.find((candidate) =>
          candidate.type === "policy-review-recorded" && candidate.data.review.reviewId === event.data.reviewId,
        );
        if (finished?.type !== "policy-review-finished" || finished.data.status !== "proposed" ||
          finished.data.reviewId !== event.data.reviewId || review?.type !== "policy-review-recorded" ||
          review.data.review.trigger !== event.data.trigger || review.data.review.policyVersion !== state.activePolicy.version) {
          throw new Error("Policy proposal does not match a completed policy review.");
        }
        if (event.data.version !== state.activePolicy.version + 1) {
          throw new Error("Policy proposal version must immediately follow the active version.");
        }
        const validation = validatePolicyProposal(state.activePolicy, event.data.proposal, event.data.version);
        const validDecision = validation.accepted
          ? event.data.accepted && event.data.reason === "Policy proposal accepted."
          : !event.data.accepted && event.data.reason === validation.reason;
        if (!validDecision || !isDeepStrictEqual(event.data.proposal, validation.proposal)) {
          throw new Error("Policy proposal validation does not match the recorded decision.");
        }
        break;
      }
      case "policy-updated": {
        const proposal = this.#events.find((candidate) => candidate.index === event.index - 1);
        if (proposal?.type !== "policy-proposed" || !proposal.data.accepted) {
          throw new Error("Policy update requires its immediately preceding accepted proposal.");
        }
        if (proposal.data.version !== event.data.version ||
          event.data.version !== state.activePolicy.version + 1 ||
          event.data.previousVersion !== state.activePolicy.version ||
          event.data.policy.version !== event.data.version) {
          throw new Error("Policy update version must equal its accepted proposal and immediately follow the active policy.");
        }
        const validation = validatePolicyProposal(state.activePolicy, proposal.data.proposal, proposal.data.version);
        if (!validation.accepted || !isDeepStrictEqual(event.data.policy, validation.policy)) {
          throw new Error("Policy update does not match its accepted bounded proposal.");
        }
        state.activePolicy = event.data.policy;
        state.policyVersion = event.data.policy.version;
        state.policyHistory = [...state.policyHistory, event.data.policy];
        state.latestDecision = `Activated policy version ${event.data.policy.version}.`;
        break;
      }
      case "policy-rolled-back": {
        if (event.data.version !== state.activePolicy.version + 1 || event.data.previousVersion !== state.activePolicy.version) {
          throw new Error("Policy rollback version is not contiguous.");
        }
        const source = state.policyHistory.find((policy) => policy.version === event.data.restoredVersion);
        if (!source || !isDeepStrictEqual(event.data.policy, restoredPolicyVersion(source, event.data.version))) {
          throw new Error("Policy rollback does not restore an earlier immutable version.");
        }
        state.activePolicy = event.data.policy;
        state.policyVersion = event.data.policy.version;
        state.policyHistory = [...state.policyHistory, event.data.policy];
        state.latestDecision = `Rolled back policy version ${event.data.previousVersion} to ${event.data.restoredVersion} as version ${event.data.version}.`;
        break;
      }
      case "run-configured":
        break;
    }
    state.lastEventIndex = event.index;
  }

  #sealWallTime(state: RunState, timestamp: number): void {
    if (this.#wallStartedAt === undefined) return;
    state.budgetUsage.wallTimeMs += Math.max(0, timestamp - this.#wallStartedAt);
    this.#wallStartedAt = undefined;
  }

  #wallTimeNow(): number {
    const state = this.#requireState();
    return state.budgetUsage.wallTimeMs + (this.#wallStartedAt === undefined
      ? 0
      : Math.max(0, this.#clock.now() - this.#wallStartedAt));
  }

  async #append<T extends RunEventType>(
    type: T,
    data: RunEventDataMap[T],
    experimentId?: string,
  ): Promise<RunEvent<T>> {
    return await this.#exclusive(() => this.#appendUnlocked(type, data, experimentId));
  }

  async #appendUnlocked<T extends RunEventType>(
    type: T,
    data: RunEventDataMap[T],
    experimentId?: string,
  ): Promise<RunEvent<T>> {
    if (this.#disposedForRecovery) throw new CoordinatorDisposedForRecoveryError();
    const state = this.#requireState();
    const event = {
      index: state.lastEventIndex + 1,
      type,
      at: at(this.#clock.now()),
      runId: state.spec.runId,
      ...(experimentId ? { experimentId } : {}),
      data,
    } as RunEvent<T>;
    const recorded = event as RunEvent;
    await this.#store.append(recorded);
    // The append itself is durable evidence of the boundary. A dead controller must
    // not mutate its in-memory projection or write a snapshot after that point.
    if (this.#disposedForRecovery) throw new CoordinatorDisposedForRecoveryError();
    this.#events.push(recorded);
    this.#apply(state, recorded);
    await this.#store.snapshot(state);
    return event;
  }

  #launchUnlocked(): void {
    if (this.#loop) return;
    const loop = this.#runLoop();
    this.#loop = loop;
    void loop.finally(() => {
      if (this.#loop === loop) this.#loop = undefined;
    });
  }

  async #runLoop(): Promise<void> {
    try {
      while (true) {
        const action = await this.#nextLoopAction();
        if (action === "return") return;
        if (action === "seed") {
          await this.#seedBaseline();
          continue;
        }
        if (action === "review") {
          await this.#reviewPolicy();
          continue;
        }
        await this.#continueActive();
      }
    } catch (error) {
      const state = this.#state;
      if (!this.#disposedForRecovery && state && state.status !== "failed") {
        await this.#append("run-failed", { reason: `Run failed: ${message(error)}` }).catch(() => undefined);
      }
    }
  }

  async #nextLoopAction(): Promise<LoopAction> {
    return await this.#exclusive(async () => {
      if (this.#disposedForRecovery || this.#clearing) return "return";
      const state = this.#requireState();
      if (state.status === "stopping") {
        if (state.activeAssignment) return "continue";
        await this.#appendUnlocked("run-stopped", { reason: state.latestDecision ?? "Stopped by user." });
        return "return";
      }
      if (state.status === "pausing") {
        if (state.activeAssignment) return "continue";
        await this.#appendUnlocked("run-paused", {});
        return "return";
      }
      if (state.status !== "running") return "return";
      if (state.activeAssignment) return "continue";
      if (Object.keys(state.nodes).length === 0) return "seed";
      const exhausted = this.#budgetExhausted();
      if (exhausted) {
        await this.#appendUnlocked("run-completed", { reason: exhausted });
        return "return";
      }
      if (this.#policyReviewTrigger()) return "review";
      const frontier = this.#controller();
      const projection = this.#frontierProjection(frontier);
      const assignment = frontier.nextAssignment(projection.history).assignment;
      // Assignment persistence and its index allocation share this lifecycle turn.
      await this.#appendUnlocked("assignment-recorded", { assignment }, assignment.experimentId);
      return "continue";
    });
  }

  /**
   * Reviews are opt-in and only occur after three completed candidate boundaries:
   * either every outcome failed/interrupted (degeneration), or none was
   * promoted (stall). A review consumes no candidate budget and at least three
   * further candidates must complete before another review may be launched.
   */
  #policyReviewTrigger(): PolicyReviewTrigger | undefined {
    const state = this.#requireState();
    if (state.spec.policyTuning?.enabled !== true || state.activePolicyReview) return undefined;
    const completed = this.#events
      .filter((event): event is Extract<RunEvent, { type: "experiment-finished" }> => event.type === "experiment-finished")
      .filter((event) => event.data.nodeId !== "baseline");
    if (completed.length < POLICY_REVIEW_SIGNAL_WINDOW) return undefined;
    const lastReview = this.#events.findLast((event) => event.type === "policy-review-recorded");
    const completedSinceReview = lastReview
      ? completed.filter((event) => event.index > lastReview.index)
      : completed;
    if (completedSinceReview.length < POLICY_REVIEW_MIN_EXPERIMENTS_BETWEEN_REVIEWS) return undefined;
    const recent = completed.slice(-POLICY_REVIEW_SIGNAL_WINDOW).map((event) => event.data.outcome);
    if (recent.every((outcome) => ["failed", "interrupted"].includes(outcome))) {
      return "degeneration-terminal-outcomes";
    }
    if (recent.every((outcome) => outcome !== "promoted")) return "stall-no-promotions";
    return undefined;
  }

  #recentPolicyOutcomes(): readonly NodeRecord["outcome"][] {
    return this.#events
      .filter((event): event is Extract<RunEvent, { type: "experiment-finished" }> => event.type === "experiment-finished")
      .filter((event) => event.data.nodeId !== "baseline")
      .slice(-POLICY_REVIEW_SIGNAL_WINDOW)
      .map((event) => event.data.outcome);
  }

  async #reviewPolicy(): Promise<void> {
    const prepared = await this.#exclusive(async () => {
      if (this.#clearing) return undefined;
      const state = this.#requireState();
      const trigger = this.#policyReviewTrigger();
      if (state.status !== "running" || state.activeAssignment || !trigger) return undefined;
      const review: PolicyReviewAssignment = {
        reviewId: `policy-review-${String(this.#events.filter((event) => event.type === "policy-review-recorded").length + 1).padStart(4, "0")}`,
        trigger,
        policyVersion: state.activePolicy.version,
      };
      await this.#appendUnlocked("policy-review-recorded", { review });
      const abort = new AbortController();
      this.#policyReviewAbort = abort;
      this.#policyReviewGroup = undefined;
      return {
        abort,
        context: {
          spec: state.spec,
          review,
          trigger,
          activePolicy: state.activePolicy,
          recentOutcomes: this.#recentPolicyOutcomes(),
        },
      };
    });
    if (!prepared) return;

    let clearMarker = false;
    let marker: WorkerMarker = {
      experimentId: prepared.context.review.reviewId,
      kind: "policy-review",
      reviewId: prepared.context.review.reviewId,
    };
    const persistMarker = async (next: WorkerMarker): Promise<void> => {
      marker = next;
      await this.#store.writeWorkerMarker(marker);
    };
    try {
      if (this.#clearing) return;
      await persistMarker(marker);
      if (this.#clearing || prepared.abort.signal.aborted) {
        clearMarker = true;
        return;
      }
      let outcome: PolicyReviewOutcome;
      try {
        outcome = await this.#policyReviewer.review(prepared.context, prepared.abort.signal, async (identity) => {
          const stopRequested = await this.#exclusive(async () => {
            await persistMarker({ ...marker, process: identity });
            this.#policyReviewGroup = identity;
            return this.#requireState().status === "stopping";
          });
          if (stopRequested && !await this.#terminateOwnedGroup(identity)) {
            throw new UnconfirmedWorkerTerminationError(identity.processGroupId);
          }
        });
      } catch (error) {
        outcome = {
          status: prepared.abort.signal.aborted ? "cancelled" : "failed",
          stdout: "",
          stderr: "Policy reviewer adapter failed.",
          reason: "Policy reviewer adapter failed.",
        };
      }
      const group = this.#policyReviewGroup;
      if (group) {
        if (!await this.#waitForOwnedGroupExit(group)) {
          throw new UnconfirmedWorkerTerminationError(group.processGroupId);
        }
        // Recovery must know that this exact group has already drained before it
        // reconciles a crash between process exit and policy-result persistence.
        await persistMarker({ ...marker, process: group, processExited: true });
      }
      await this.#exclusive(async () => {
        if (this.#disposedForRecovery) return;
        const state = this.#requireState();
        const stopped = prepared.abort.signal.aborted || state.status === "stopping";
        const finishedStatus = stopped ? "cancelled" : outcome.status;
        await this.#appendUnlocked("policy-review-finished", {
          reviewId: prepared.context.review.reviewId,
          status: finishedStatus,
          reason: stopped ? "Policy review interrupted by stop request." : policyReviewFinishedReason(outcome),
        });
        if (!stopped && outcome.status === "proposed") {
          const version = state.activePolicy.version + 1;
          const validation = validatePolicyProposal(state.activePolicy, outcome.proposal, version);
          const reason = validation.accepted ? "Policy proposal accepted." : validation.reason;
          await this.#appendUnlocked("policy-proposed", {
            version,
            reviewId: prepared.context.review.reviewId,
            trigger: prepared.context.trigger,
            proposal: validation.proposal,
            accepted: validation.accepted,
            reason,
          });
          if (validation.accepted) {
            await this.#appendUnlocked("policy-updated", {
              version: validation.policy.version,
              previousVersion: state.activePolicy.version,
              policy: validation.policy,
            });
          }
        }
      });
    } finally {
      await this.#exclusive(async () => {
        if (this.#policyReviewAbort === prepared.abort) {
          clearMarker ||= !this.#disposedForRecovery && this.#events.some((event) =>
            event.type === "policy-review-finished" && event.data.reviewId === prepared.context.review.reviewId,
          );
          this.#policyReviewAbort = undefined;
          this.#policyReviewGroup = undefined;
          this.#workerPassiveExitWait = undefined;
          this.#workerActiveTermination = undefined;
        }
      });
      if (clearMarker) await this.#store.clearWorkerMarker();
    }
  }

  #budgetExhausted(): string | undefined {
    const state = this.#requireState();
    const { budget } = state.spec;
    const { budgetUsage } = state;
    if (budget.maxExperiments !== undefined && budgetUsage.experiments >= budget.maxExperiments) {
      return `Experiment budget reached (${budget.maxExperiments}).`;
    }
    if (budget.maxWallTimeMs !== undefined && this.#wallTimeNow() >= budget.maxWallTimeMs) {
      return `Wall-time budget reached (${budget.maxWallTimeMs} ms).`;
    }
    if (budget.maxReportedCostUsd !== undefined && budgetUsage.reportedCostUsd >= budget.maxReportedCostUsd) {
      return `Reported-cost budget reached (US$${budget.maxReportedCostUsd}).`;
    }
    return undefined;
  }

  async #seedBaseline(): Promise<void> {
    const state = this.#requireState();
    const baseline = state.baseline;
    if (!baseline) throw new Error("Configured run has no baseline.");
    const repository = await this.#workspace.inspectRepository(state.spec.targetRepository);
    const provisional: NodeRecord = {
      id: "baseline",
      commit: repository.head,
      ref: `refs/pi-frontier-autoresearch/${state.spec.runId}/nodes/baseline`,
      parentIds: [],
      operator: "baseline",
      hypothesis: "Configured baseline.",
      reflection: "Baseline calibrated before the run started.",
      diffSummary: { changedFiles: [], changedLines: 0 },
      metricSamples: baseline.samples,
      guardResults: [],
      outcome: "pending",
      policyVersion: state.policyVersion,
      createdEventIndex: 0,
      selection: { attempts: 0, promotions: 0 },
    };
    const frontier = this.#controller();
    const projection = this.#frontierProjection(frontier);
    const transition = frontier.recordEvaluation(projection.history, {
      node: provisional,
      evaluation: baselineEvaluation(state.spec, baseline),
    });
    await this.#workspace.persistNode(transition.node);
    await this.#append("node-recorded", { node: transition.node });
    await this.#append("evaluation-recorded", { evaluation: baselineEvaluation(state.spec, baseline) });
    await this.#append("frontier-updated", { slots: transition.frontier, reason: transition.decision.reason });
    await this.#append("experiment-finished", { nodeId: transition.node.id, outcome: transition.node.outcome });
  }

  async #continueActive(): Promise<void> {
    const current = await this.#exclusive(async () => {
      const state = this.#requireState();
      const assignment = state.activeAssignment;
      if (!assignment) return { kind: "none" as const };
      const node = state.nodes[assignment.experimentId];
      const frontier = this.#controller();
      const projection = this.#frontierProjection(frontier);
      if (projection.pendingTransition) return { kind: "transition" as const, transition: projection.pendingTransition };
      if (projection.persistedTransition) return { kind: "finished" as const, assignment, transition: projection.persistedTransition };
      if (node) return { kind: "node" as const, assignment, node, frontier, projection };
      const parent = state.nodes[assignment.primaryParentId];
      const donor = assignment.donorParentId ? state.nodes[assignment.donorParentId] : undefined;
      if (!parent) throw new Error(`Assignment ${assignment.experimentId} has no primary parent.`);
      if (state.status === "stopping") return { kind: "interrupt" as const, assignment, parent, donor };
      const abort = new AbortController();
      this.#workerAbort = abort;
      this.#workerGroup = undefined;
      return { kind: "worker" as const, assignment, parent, donor, abort };
    });

    if (current.kind === "none") return;
    if (current.kind === "transition") {
      await this.#persistTransition(current.transition);
      return;
    }
    if (current.kind === "finished") {
      await this.#append("experiment-finished", {
        nodeId: current.transition.node.id,
        outcome: current.transition.node.outcome,
      }, current.assignment.experimentId);
      return;
    }
    if (current.kind === "node") {
      if (current.node.outcome === "failed" || current.node.outcome === "interrupted") {
        const transition = current.frontier.recordEvaluation(current.projection.history, {
          node: current.node,
          failureReason: current.node.reflection,
        });
        await this.#persistTransition(transition);
        return;
      }
      await this.#evaluatePersistedCandidate(current.assignment, current.node, current.frontier, current.projection);
      return;
    }
    if (current.kind === "interrupt") {
      await this.#closeInterruptedAssignment(current.assignment, current.parent, current.donor, "Stop requested before worker launch.");
      return;
    }
    await this.#runWorker(current);
  }

  async #runWorker(current: ActiveWorker): Promise<void> {
    const { assignment, parent, donor, abort } = current;
    if (this.#clearing) return;
    let processGroupConfirmed = false;
    let clearMarker = false;
    let marker: WorkerMarker = { experimentId: assignment.experimentId };
    const persistMarker = async (next: WorkerMarker): Promise<void> => {
      marker = next;
      await this.#store.writeWorkerMarker(marker);
    };
    try {
      await persistMarker(marker);
      if (this.#disposedForRecovery) return;
      if (this.#clearing) {
        clearMarker = true;
        return;
      }
      if (abort.signal.aborted || this.#requireState().status === "stopping") {
        await this.#closeInterruptedAssignment(assignment, parent, donor, "Stop requested before worker launch.");
        return;
      }
      let created;
      try {
        created = await this.#creator.create({
          spec: this.#requireState().spec,
          assignment,
          parent,
          donor,
          signal: abort.signal,
          onProcessGroup: async (identity) => {
            const stopRequested = await this.#exclusive(async () => {
              // The worker cannot continue past its spawn callback until this exact
              // identity is durable, and stop cannot observe it before that point.
              await persistMarker({ ...marker, process: identity });
              this.#workerGroup = identity;
              return this.#requireState().status === "stopping";
            });
            if (stopRequested) {
              if (!await this.#terminateOwnedGroup(identity)) {
                throw new UnconfirmedWorkerTerminationError(identity.processGroupId);
              }
              processGroupConfirmed = true;
            }
          },
          onWorkerResult: async (worker) => {
            // This is before passive descendant waiting, metadata verification, and
            // Git-backed node persistence. Recovery can therefore account for a
            // billed worker even if any later candidate boundary crashes.
            await persistMarker({
              ...marker,
              ...(processGroupConfirmed ? { processExited: true } : {}),
              ...(worker.reportedCostUsd === undefined ? {} : { reportedCostUsd: worker.reportedCostUsd }),
              status: worker.status,
              ...(worker.reason === undefined ? {} : { reason: worker.reason }),
            });
          },
          onProcessGroupExit: async (identity) => {
            // A worker result only proves its leader exited. Confirm the complete
            // group before touching the worktree, but retain durable ownership until
            // worker-finished and node-recorded make recovery deterministic.
            if (!await this.#waitForOwnedGroupExit(identity)) {
              throw new UnconfirmedWorkerTerminationError(identity.processGroupId);
            }
            processGroupConfirmed = true;
            if (this.#disposedForRecovery) throw new CoordinatorDisposedForRecoveryError();
            await persistMarker({ ...marker, process: identity, processExited: true });
          },
        });
      } catch (error) {
        if (error instanceof WorkerLaunchPreventedError) {
          await this.#closeInterruptedAssignment(assignment, parent, donor, "Stop requested before worker launch.");
          return;
        }
        throw error;
      }
      if (this.#disposedForRecovery) return;
      const interrupted = abort.signal.aborted || this.#requireState().status === "stopping";
      if (interrupted) {
        processGroupConfirmed = await this.#confirmOwnedWorkerTermination();
        await this.#closeInterruptedAssignment(
          assignment,
          parent,
          donor,
          "Worker interrupted by stop request.",
          created.node,
          created.node.reportedCostUsd,
        );
        return;
      }
      await this.#append("worker-finished", {
        status: created.node.outcome,
        ...(created.node.reportedCostUsd === undefined ? {} : { reportedCostUsd: created.node.reportedCostUsd }),
        ...(created.reason ? { reason: created.reason } : {}),
      }, assignment.experimentId);
      if (created.node.outcome !== "pending") {
        const frontier = this.#controller();
        const projection = this.#frontierProjection(frontier);
        const transition = frontier.recordEvaluation(projection.history, {
          node: created.node,
          failureReason: created.node.reflection,
        });
        await this.#workspace.persistNode(transition.node);
        await this.#append("node-recorded", { node: transition.node }, assignment.experimentId);
        await this.#persistTransition(transition);
        return;
      }
      await this.#evaluateNewCandidate(assignment, created.node);
    } finally {
      await this.#exclusive(async () => {
        if (this.#workerAbort === abort) {
          const ownsProcessGroup = this.#workerGroup !== undefined;
          // A marker survives every candidate crash gap. It is clearable only after
          // full-group exit and both replayable worker and node boundaries exist.
          clearMarker ||= !this.#disposedForRecovery &&
            (!ownsProcessGroup || processGroupConfirmed) &&
            this.#markerBoundariesRecorded(assignment.experimentId);
          this.#workerAbort = undefined;
          this.#workerGroup = undefined;
          this.#workerPassiveExitWait = undefined;
          this.#workerActiveTermination = undefined;
        }
      });
      if (clearMarker) await this.#store.clearWorkerMarker();
    }
  }

  async #closeInterruptedAssignment(
    assignment: Assignment,
    parent: NodeRecord,
    donor: NodeRecord | undefined,
    reason: string,
    candidate?: NodeRecord,
    reportedCostUsd?: number,
  ): Promise<void> {
    const state = this.#requireState();
    if (state.nodes[assignment.experimentId]) return;
    let node = candidate ?? await this.#workspace.readNodeRecord(assignment.experimentId).catch(() => undefined);
    if (!node) node = await this.#creator.interrupt({ spec: state.spec, assignment, parent, donor }, reason);
    const interrupted = { ...node, outcome: "interrupted" as const, reflection: reason };
    await this.#workspace.persistNode(interrupted);
    if (!this.#hasExperimentEvent("worker-finished", assignment.experimentId)) {
      await this.#append("worker-finished", {
        status: "interrupted",
        ...(reportedCostUsd === undefined ? {} : { reportedCostUsd }),
        reason,
      }, assignment.experimentId);
    }
    if (!this.#requireState().nodes[assignment.experimentId]) {
      await this.#append("node-recorded", { node: interrupted }, assignment.experimentId);
    }
    const frontier = this.#controller();
    const projection = this.#frontierProjection(frontier);
    if (projection.pendingTransition) await this.#persistTransition(projection.pendingTransition);
    else if (projection.persistedTransition) {
      await this.#append("experiment-finished", {
        nodeId: projection.persistedTransition.node.id,
        outcome: projection.persistedTransition.node.outcome,
      }, assignment.experimentId);
    }
  }

  #hasExperimentEvent(type: RunEventType, experimentId: string): boolean {
    return this.#events.some((event) => event.type === type && event.experimentId === experimentId);
  }

  #markerBoundariesRecorded(experimentId: string): boolean {
    return this.#hasExperimentEvent("worker-finished", experimentId) &&
      this.#requireState().nodes[experimentId] !== undefined;
  }

  #policyReviewBoundaryRecorded(reviewId: string): boolean {
    return this.#events.some((event) => event.type === "policy-review-finished" && event.data.reviewId === reviewId);
  }

  async #evaluateNewCandidate(assignment: Assignment, candidate: NodeRecord): Promise<void> {
    // Candidate creation has committed and persisted this node already. Recording the
    // boundary before evaluation means a crash resumes this candidate exactly once.
    await this.#append("node-recorded", { node: candidate }, assignment.experimentId);
    const frontier = this.#controller();
    const projection = this.#frontierProjection(frontier);
    await this.#evaluatePersistedCandidate(assignment, candidate, frontier, projection);
  }

  async #evaluatePersistedCandidate(
    assignment: Assignment,
    candidate: NodeRecord,
    frontier: FrontierController,
    projection: FrontierProjection,
  ): Promise<void> {
    const parent = this.#requireState().nodes[assignment.primaryParentId];
    if (!parent) throw new Error(`Assignment ${assignment.experimentId} has no primary parent.`);
    try {
      const evaluation = await this.#evaluator.evaluate(
        this.#requireState().spec,
        candidate,
        parent,
        frontier.createPromotionGate(projection.history),
      );
      await this.#append("evaluation-recorded", { evaluation }, assignment.experimentId);
      const transition = frontier.recordEvaluation(projection.history, { node: candidate, evaluation });
      await this.#workspace.persistNode(transition.node);
      await this.#persistTransition(transition);
    } catch (error) {
      const transition = frontier.recordEvaluation(projection.history, {
        node: { ...candidate, outcome: "failed", reflection: `Evaluator failed: ${message(error)}` },
        failureReason: `Evaluator failed: ${message(error)}`,
      });
      await this.#workspace.persistNode(transition.node);
      await this.#persistTransition(transition);
    }
  }

  async #persistTransition(transition: Extract<FrontierEvent, { type: "evaluation-recorded" }>): Promise<void> {
    const experimentId = transition.node.operator === "baseline"
      ? undefined
      : this.#requireState().activeAssignment?.experimentId ?? transition.node.id;
    await this.#append("frontier-updated", { slots: transition.frontier, reason: transition.decision.reason }, experimentId);
    await this.#append(
      "experiment-finished",
      { nodeId: transition.node.id, outcome: transition.node.outcome },
      experimentId,
    );
  }

  #frontierProjection(frontier: FrontierController): FrontierProjection {
    const history: FrontierEvent[] = [];
    let node: NodeRecord | undefined;
    let transition: Extract<FrontierEvent, { type: "evaluation-recorded" }> | undefined;
    let pendingTransition: Extract<FrontierEvent, { type: "evaluation-recorded" }> | undefined;
    let persistedTransition: Extract<FrontierEvent, { type: "evaluation-recorded" }> | undefined;
    for (const event of this.#events) {
      if (event.type === "frontier-policy-recorded") {
        history.push(frontier.recordPolicy());
        continue;
      }
      if (event.type === "assignment-recorded") {
        if (node || pendingTransition) throw new Error("Run history advanced before its experiment was finished.");
        const planned = frontier.nextAssignment(history, {
          experimentId: event.data.assignment.experimentId,
          hypothesis: event.data.assignment.hypothesis,
          policyVersion: event.data.assignment.policyVersion,
        });
        if (!isDeepStrictEqual(planned.assignment, event.data.assignment)) {
          throw new Error(`Assignment ${event.data.assignment.experimentId} does not match the frontier policy.`);
        }
        history.push(planned);
        continue;
      }
      if (event.type === "node-recorded") {
        if (node) throw new Error("Run history contains two candidate nodes without a decision.");
        node = event.data.node;
        continue;
      }
      if (event.type === "evaluation-recorded") {
        if (!node || node.id !== event.data.evaluation.nodeId) {
          throw new Error("Evaluation does not match the recorded candidate node.");
        }
        transition = frontier.recordEvaluation(history, { node, evaluation: event.data.evaluation });
        history.push(transition);
        node = undefined;
        pendingTransition = transition;
        continue;
      }
      if (event.type === "frontier-updated") {
        if (!pendingTransition && node) {
          transition = frontier.recordEvaluation(history, { node, failureReason: node.reflection });
          history.push(transition);
          node = undefined;
          pendingTransition = transition;
        }
        if (!pendingTransition) throw new Error("Frontier update has no candidate decision.");
        if (!isDeepStrictEqual(pendingTransition.frontier, event.data.slots)) {
          throw new Error("Recorded frontier does not match the frontier policy.");
        }
        persistedTransition = pendingTransition;
        pendingTransition = undefined;
        continue;
      }
      if (event.type === "experiment-finished") {
        if (pendingTransition || node || !persistedTransition) {
          throw new Error("Experiment finished before its frontier decision was persisted.");
        }
        if (event.data.nodeId !== persistedTransition.node.id) {
          throw new Error("Experiment finished does not match its frontier decision.");
        }
        persistedTransition = undefined;
      }
    }
    return {
      history,
      ...(pendingTransition ? { pendingTransition } : {}),
      ...(persistedTransition ? { persistedTransition } : {}),
      ...(node ? { pendingNode: node } : {}),
    };
  }

  async #recoverWorkerOwnershipUnlocked(marker: WorkerMarker): Promise<boolean> {
    if (!marker.process) {
      await this.#appendUnlocked("run-failed", {
        reason: `Recovery requires intervention: worker marker for ${marker.experimentId} has no durable process identity; refusing workspace cleanup or relaunch.`,
      });
      return false;
    }
    if (marker.processExited) {
      // A prior controller durably observed this exact group absent. Keep ownership
      // through reconciliation: worker-finished and node-recorded may still be
      // missing after a crash between candidate persistence and those boundaries.
      return true;
    }
    // Never signal a raw recovered PGID. A leader PID can be reused after a crash;
    // identity must still match before the executor is even asked to terminate it.
    const identityCurrent = await this.#process.isProcessGroupIdentityCurrent(marker.process).catch(() => false);
    if (!identityCurrent) {
      await this.#appendUnlocked("run-failed", {
        reason: `Recovery requires intervention: worker process identity for group ${marker.process.processGroupId} is absent or mismatched; refusing termination, workspace cleanup, or relaunch.`,
      });
      return false;
    }
    const confirmed = await this.#process.terminateRecoveredProcessGroupAndWait(marker.process, 2_000).catch(() => false);
    if (confirmed !== true) {
      await this.#appendUnlocked("run-failed", {
        reason: `Recovery requires intervention: could not confirm process group ${marker.process.processGroupId} has exited; refusing workspace cleanup or relaunch.`,
      });
      return false;
    }
    await this.#store.writeWorkerMarker({ ...marker, processExited: true });
    return true;
  }

  async #reconcileActivePolicyReviewUnlocked(marker: WorkerMarker | undefined): Promise<void> {
    const review = this.#requireState().activePolicyReview;
    if (!review) return;
    if (marker && review.reviewId !== (marker.reviewId ?? marker.experimentId)) {
      throw new Error("Recovered policy-review marker does not match the active policy review.");
    }
    if (!this.#policyReviewBoundaryRecorded(review.reviewId)) {
      await this.#appendUnlocked("policy-review-finished", {
        reviewId: review.reviewId,
        status: "cancelled",
        reason: "Policy review interrupted during recovery.",
      });
    }
  }

  async #reconcileActiveAssignmentUnlocked(marker: WorkerMarker | undefined): Promise<void> {
    const state = this.#requireState();
    const assignment = state.activeAssignment;
    if (!assignment) return;
    const parent = state.nodes[assignment.primaryParentId];
    const donor = assignment.donorParentId ? state.nodes[assignment.donorParentId] : undefined;
    if (!parent) throw new Error(`Recovered assignment ${assignment.experimentId} has no primary parent.`);

    // A worker-finished event or node record is durable evidence that this candidate
    // was committed. A stale ownership marker must not rewrite it as interrupted.
    let persisted: NodeRecord | undefined = state.nodes[assignment.experimentId];
    if (!persisted) persisted = await this.#workspace.readNodeRecord(assignment.experimentId).catch(() => undefined);
    if (persisted) {
      const durable = persisted;
      // CandidateCreator persists this Git-backed record before worker-finished. If a
      // session dies in that interval, replay the missing accounting boundary first.
      if (!this.#hasExperimentEvent("worker-finished", assignment.experimentId)) {
        const recoveredMarker = marker?.experimentId === assignment.experimentId ? marker : undefined;
        await this.#appendUnlocked("worker-finished", {
          status: durable.outcome,
          ...(recoveredMarker?.reportedCostUsd === undefined
            ? (durable.reportedCostUsd === undefined ? {} : { reportedCostUsd: durable.reportedCostUsd })
            : { reportedCostUsd: recoveredMarker.reportedCostUsd }),
          ...(recoveredMarker?.reason === undefined ? {} : { reason: recoveredMarker.reason }),
        }, assignment.experimentId);
      }
      if (!state.nodes[durable.id]) await this.#appendUnlocked("node-recorded", { node: durable }, assignment.experimentId);
      return;
    }

    const reason = marker && marker.experimentId === assignment.experimentId
      ? "Worker interrupted during recovery."
      : "Run recovered before the assigned worker was durably known to finish.";
    const interrupted = await this.#creator.interrupt({ spec: state.spec, assignment, parent, donor }, reason);
    await this.#workspace.persistNode(interrupted);
    if (!this.#hasExperimentEvent("worker-finished", assignment.experimentId)) {
      const recoveredMarker = marker?.experimentId === assignment.experimentId ? marker : undefined;
      await this.#appendUnlocked("worker-finished", {
        status: "interrupted",
        ...(recoveredMarker?.reportedCostUsd === undefined ? {} : { reportedCostUsd: recoveredMarker.reportedCostUsd }),
        reason,
      }, assignment.experimentId);
    }
    await this.#appendUnlocked("node-recorded", { node: interrupted }, assignment.experimentId);
    const frontier = this.#controller();
    const projection = this.#frontierProjection(frontier);
    if (projection.pendingTransition) {
      const experimentId = assignment.experimentId;
      await this.#appendUnlocked("frontier-updated", {
        slots: projection.pendingTransition.frontier,
        reason: projection.pendingTransition.decision.reason,
      }, experimentId);
      await this.#appendUnlocked("experiment-finished", {
        nodeId: projection.pendingTransition.node.id,
        outcome: projection.pendingTransition.node.outcome,
      }, experimentId);
    }
  }

  async #confirmOwnedWorkerTermination(): Promise<boolean> {
    const identity = this.#workerGroup;
    if (!identity) return true;
    if (!await this.#terminateOwnedGroup(identity)) {
      throw new UnconfirmedWorkerTerminationError(identity.processGroupId);
    }
    return true;
  }

  async #terminateOwnedGroup(identity: ProcessGroupIdentity): Promise<boolean> {
    // An active stop must never be satisfied by an already-running passive wait.
    // Sharing only active callers avoids redundant signals while preserving that
    // guarantee for a stop racing a leader exit or descendant drain.
    if (!this.#workerActiveTermination) {
      this.#workerActiveTermination = this.#process.terminateOwnedProcessGroupAndWait(identity, 2_000).catch(() => false);
    }
    return await this.#workerActiveTermination;
  }

  async #waitForOwnedGroupExit(identity: ProcessGroupIdentity): Promise<boolean> {
    if (!this.#workerPassiveExitWait) {
      this.#workerPassiveExitWait = this.#process.waitForProcessGroupExit(identity, 2_000).catch(() => false);
    }
    return await this.#workerPassiveExitWait;
  }
}
