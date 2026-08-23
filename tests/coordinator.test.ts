import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, appendFile, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import frontierAutoresearch from "../extensions/pi-frontier-autoresearch/index.ts";
import {
  Evaluator,
  GitWorkspaceAdapter,
  LocalRunStore,
  ManualClock,
  NodeProcessExecutor,
  PolicyReviewer,
  RunCommandRouter,
  RunCoordinator,
  type Evaluation,
  type EvaluatorAdapter,
  type RunSpec,
  type ProcessExecutor,
  type ProcessGroupIdentity,
  type ProcessRequest,
  type ProcessResult,
  type StoreAdapter,
  type WorkerAdapter,
  type WorkerOutcome,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);

function processIdentity(processGroupId: number): ProcessGroupIdentity {
  return { processGroupId, leaderPid: processGroupId, leaderStartIdentity: `fixture-start-${processGroupId}` };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

function spec(root: string): RunSpec {
  return {
    schemaVersion: 1,
    runId: "coordinator-fixture",
    targetRepository: root,
    objective: "Improve a small generic program",
    primaryMetric: "score",
    metrics: [{ name: "score", direction: "higher" }],
    evaluator: { command: "printf 'METRIC score=100\\n'", timeoutMs: 1_000 },
    editableGlobs: ["source.txt"],
    protectedPaths: [],
    probes: [],
    guards: [],
    budget: { maxExperiments: 1 },
    baseline: { samples: 1 },
    confirmation: { maxSamples: 1, confidenceMultiplier: 1 },
    frontierPolicy: {
      size: 4,
      leanPrimaryTolerance: 0.1,
      diversePrimaryTolerance: 0.1,
      diverseNoveltyThreshold: 0.1,
      crossoverCadence: 2,
    },
  };
}

class FailingWorker implements WorkerAdapter {
  calls = 0;

  async run(): Promise<WorkerOutcome> {
    this.calls += 1;
    return { status: "failed", stdout: "", stderr: "fixture worker failed", reason: "fixture worker failed" };
  }
}

class ScriptedWorker implements WorkerAdapter {
  readonly #clock?: ManualClock;
  readonly #reportedCost?: number;
  calls = 0;
  active = 0;
  maximumActive = 0;
  assignments: string[] = [];

  constructor(options: { clock?: ManualClock; reportedCost?: number } = {}) {
    this.#clock = options.clock;
    this.#reportedCost = options.reportedCost;
  }

  async run(
    _spec: RunSpec,
    assignment: import("../src/index.ts").Assignment,
    worktree: import("../src/index.ts").WorktreeHandle,
    _signal?: AbortSignal,
    onProcessGroup?: (identity: ProcessGroupIdentity) => void | Promise<void>,
  ): Promise<WorkerOutcome> {
    this.calls += 1;
    await onProcessGroup?.(processIdentity(900 + this.calls));
    this.assignments.push(assignment.operator);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      await mkdir(join(worktree.path, "src"), { recursive: true });
      const lines = this.calls === 1 ? 5 : 1;
      await writeFile(join(worktree.path, "src", `change-${this.calls}.txt`), `${"change\\n".repeat(lines)}`);
      this.#clock?.advance(5);
      return {
        status: "submitted",
        stdout: "fixture worker",
        stderr: "",
        ...(this.#reportedCost === undefined ? {} : { reportedCostUsd: this.#reportedCost }),
        submission: {
          hypothesis: `Change ${this.calls}`,
          change: "One generic code change",
          expectedEffect: "Improve score",
          reflection: "Use the next experiment to explore another file",
        },
      };
    } finally {
      this.active -= 1;
    }
  }
}

class BlockingWorker implements WorkerAdapter {
  started = false;
  calls = 0;
  #release: (() => void) | undefined;
  readonly released = new Promise<void>((resolve) => (this.#release = resolve));

  release(): void {
    this.#release?.();
  }

  async run(
    _spec: RunSpec,
    assignment: import("../src/index.ts").Assignment,
    worktree: import("../src/index.ts").WorktreeHandle,
    signal?: AbortSignal,
    onProcessGroup?: (identity: ProcessGroupIdentity) => void | Promise<void>,
  ): Promise<WorkerOutcome> {
    this.calls += 1;
    this.started = true;
    await onProcessGroup?.(processIdentity(321));
    await mkdir(join(worktree.path, "src"), { recursive: true });
    await writeFile(join(worktree.path, "src", "blocked.txt"), "blocked\\n");
    await Promise.race([
      this.released,
      new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
    ]);
    if (signal?.aborted) return { status: "cancelled", stdout: "", stderr: "", reason: "cancelled" };
    return {
      status: "submitted",
      stdout: "",
      stderr: "",
      submission: { hypothesis: assignment.hypothesis, change: "Blocked change", expectedEffect: "Improve score", reflection: "done" },
    };
  }
}

class LocalPosixBlockingWorker implements WorkerAdapter {
  readonly #process: NodeProcessExecutor;
  readonly #released = deferred();
  identity: ProcessGroupIdentity | undefined;
  started = false;
  groupReported = false;
  abandoned = false;

  constructor(processExecutor: NodeProcessExecutor) {
    this.#process = processExecutor;
  }

  abandonForRecovery(): void {
    this.abandoned = true;
  }

  release(): void {
    this.#released.resolve();
  }

  async run(
    _spec: RunSpec,
    _assignment: import("../src/index.ts").Assignment,
    _worktree: import("../src/index.ts").WorktreeHandle,
    signal?: AbortSignal,
    onProcessGroup?: (identity: ProcessGroupIdentity) => void | Promise<void>,
  ): Promise<WorkerOutcome> {
    this.started = true;
    const result = await this.#process.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
      cwd: process.cwd(),
      onProcessGroup: async (identity) => {
        this.identity = identity;
        await onProcessGroup?.(identity);
        this.groupReported = true;
      },
    }, signal);
    if (this.abandoned) await this.#released.promise;
    return {
      status: result.cancelled ? "cancelled" : "failed",
      stdout: result.stdout,
      stderr: result.stderr,
      ...(this.identity ? { process: this.identity } : {}),
      reason: result.cancelled ? "cancelled" : "local process exited",
    };
  }
}

class ConcurrentConfigureProcess implements ProcessExecutor {
  readonly #delegate: NodeProcessExecutor;
  readonly #barrier: { arrived: number; ready: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
  shellRuns = 0;
  calibrationRuns = 0;

  constructor(
    clock: ManualClock,
    barrier: { arrived: number; ready: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> },
  ) {
    this.#delegate = new NodeProcessExecutor(clock);
    this.#barrier = barrier;
  }

  async run(request: ProcessRequest, signal?: AbortSignal): Promise<ProcessResult> {
    if (request.command === "/bin/sh") {
      this.shellRuns += 1;
      if (this.shellRuns === 1) {
        this.#barrier.arrived += 1;
        if (this.#barrier.arrived === 2) this.#barrier.ready.resolve();
        await this.#barrier.release.promise;
      } else {
        this.calibrationRuns += 1;
      }
    }
    return await this.#delegate.run(request, signal);
  }

  isProcessGroupIdentityCurrent(identity: ProcessGroupIdentity): Promise<boolean> {
    return this.#delegate.isProcessGroupIdentityCurrent(identity);
  }

  terminateOwnedProcessGroupAndWait(identity: ProcessGroupIdentity, timeoutMs: number): Promise<boolean> {
    return this.#delegate.terminateOwnedProcessGroupAndWait(identity, timeoutMs);
  }

  terminateRecoveredProcessGroupAndWait(identity: ProcessGroupIdentity, timeoutMs: number): Promise<boolean> {
    return this.#delegate.terminateRecoveredProcessGroupAndWait(identity, timeoutMs);
  }

  waitForProcessGroupExit(identity: ProcessGroupIdentity, timeoutMs: number): Promise<boolean> {
    return this.#delegate.waitForProcessGroupExit(identity, timeoutMs);
  }
}

class RecordingProcess implements ProcessExecutor {
  readonly #delegate: NodeProcessExecutor;
  terminated: number[] = [];
  confirmed: number[] = [];
  exited: number[] = [];
  checked: number[] = [];
  identityCurrent = true;
  terminationConfirmed = true;
  exitConfirmed = true;
  readonly terminationStarted = deferred();
  terminationGate: Promise<void> | undefined;

  constructor(clock: ManualClock) {
    this.#delegate = new NodeProcessExecutor(clock);
  }

  run(request: ProcessRequest, signal?: AbortSignal): Promise<ProcessResult> {
    return this.#delegate.run(request, signal);
  }

  async isProcessGroupIdentityCurrent(identity: ProcessGroupIdentity): Promise<boolean> {
    this.checked.push(identity.processGroupId);
    return this.identityCurrent;
  }

  async terminateOwnedProcessGroupAndWait(identity: ProcessGroupIdentity, _timeoutMs: number): Promise<boolean> {
    this.terminated.push(identity.processGroupId);
    this.terminationStarted.resolve();
    await this.terminationGate;
    if (this.terminationConfirmed) this.confirmed.push(identity.processGroupId);
    return this.terminationConfirmed;
  }

  async terminateRecoveredProcessGroupAndWait(identity: ProcessGroupIdentity, _timeoutMs: number): Promise<boolean> {
    if (!this.identityCurrent) return false;
    this.terminated.push(identity.processGroupId);
    this.terminationStarted.resolve();
    await this.terminationGate;
    if (this.terminationConfirmed) this.confirmed.push(identity.processGroupId);
    return this.terminationConfirmed;
  }

  async waitForProcessGroupExit(identity: ProcessGroupIdentity, _timeoutMs: number): Promise<boolean> {
    this.exited.push(identity.processGroupId);
    return this.exitConfirmed;
  }
}

class PassiveWaitRaceProcess implements ProcessExecutor {
  readonly #delegate: NodeProcessExecutor;
  readonly passiveWaitStarted = deferred();
  readonly #releasePassiveWait = deferred();
  terminated: number[] = [];

  constructor(clock: ManualClock) {
    this.#delegate = new NodeProcessExecutor(clock);
  }

  releasePassiveWait(): void {
    this.#releasePassiveWait.resolve();
  }

  run(request: ProcessRequest, signal?: AbortSignal): Promise<ProcessResult> {
    return this.#delegate.run(request, signal);
  }

  async isProcessGroupIdentityCurrent(identity: ProcessGroupIdentity): Promise<boolean> {
    return await this.#delegate.isProcessGroupIdentityCurrent(identity);
  }

  async terminateOwnedProcessGroupAndWait(identity: ProcessGroupIdentity, timeoutMs: number): Promise<boolean> {
    this.terminated.push(identity.processGroupId);
    return await this.#delegate.terminateOwnedProcessGroupAndWait(identity, timeoutMs);
  }

  async terminateRecoveredProcessGroupAndWait(identity: ProcessGroupIdentity, timeoutMs: number): Promise<boolean> {
    return await this.#delegate.terminateRecoveredProcessGroupAndWait(identity, timeoutMs);
  }

  async waitForProcessGroupExit(identity: ProcessGroupIdentity, timeoutMs: number): Promise<boolean> {
    this.passiveWaitStarted.resolve();
    await this.#releasePassiveWait.promise;
    return await this.#delegate.waitForProcessGroupExit(identity, timeoutMs);
  }
}

class DescendantExitWorker implements WorkerAdapter {
  readonly #process: ProcessExecutor;
  identity: ProcessGroupIdentity | undefined;

  constructor(processExecutor: ProcessExecutor) {
    this.#process = processExecutor;
  }

  async run(
    _spec: RunSpec,
    _assignment: import("../src/index.ts").Assignment,
    _worktree: import("../src/index.ts").WorktreeHandle,
    signal?: AbortSignal,
    onProcessGroup?: (identity: ProcessGroupIdentity) => void | Promise<void>,
  ): Promise<WorkerOutcome> {
    const result = await this.#process.run({
      command: process.execPath,
      // The leader exits while its inherited-group descendant deliberately remains.
      args: ["-e", "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' }); setTimeout(() => process.exit(0), 10);"],
      cwd: process.cwd(),
      onProcessGroup: async (identity) => {
        this.identity = identity;
        await onProcessGroup?.(identity);
      },
    }, signal);
    return {
      status: result.cancelled ? "cancelled" : "submitted",
      stdout: result.stdout,
      stderr: result.stderr,
      ...(this.identity ? { process: this.identity } : {}),
      ...(result.cancelled ? { reason: "cancelled" } : {}),
      submission: {
        hypothesis: "descendant fixture",
        change: "none",
        expectedEffect: "none",
        reflection: "stop race fixture",
      },
    };
  }
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForProcessGroupExit(processGroupId: number, description: string): Promise<void> {
  await waitFor(() => {
    try {
      process.kill(-processGroupId, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
  }, description);
}

function evaluation(nodeId: string, score: number, confirmed = true): Evaluation {
  return {
    nodeId,
    samples: { score: [score] },
    summaries: { score: { median: score, medianAbsoluteDeviation: 0, minimum: score, maximum: score } },
    guards: [{ name: "fixture", status: "passed" }],
    protectedPathsIntact: true,
    scopeValid: true,
    confirmationAttempted: false,
    confirmed,
    reason: "fixture evaluation",
  };
}

function trustedEvaluator(scores: Readonly<Record<string, number>>, gates: Array<string | undefined> = []) {
  return {
    async calibrate(config: RunSpec) {
      return evaluation(`baseline:${config.runId}`, 100);
    },
    async evaluate(_config: RunSpec, candidate: import("../src/index.ts").NodeRecord, _parent: import("../src/index.ts").NodeRecord, gate: import("../src/index.ts").PromotionGate) {
      const score = scores[candidate.id] ?? 100;
      gates.push(gate({ candidate, initialEvaluation: evaluation(candidate.id, score, false) }));
      return evaluation(candidate.id, score);
    },
  };
}

function coordinator(
  root: string,
  worker: WorkerAdapter,
  clock: ManualClock,
  options: {
    evaluator?: EvaluatorAdapter;
    processExecutor?: ProcessExecutor;
    store?: StoreAdapter;
    policyReviewer?: import("../src/index.ts").PolicyReviewerAdapter;
  } = {},
): RunCoordinator {
  const processExecutor = options.processExecutor ?? new NodeProcessExecutor(clock);
  const workspace = new GitWorkspaceAdapter({
    repository: root,
    runId: "coordinator-fixture",
    processExecutor,
  });
  return new RunCoordinator({
    store: options.store ?? new LocalRunStore(root),
    workspace,
    worker,
    evaluator: options.evaluator ?? trustedEvaluator({}),
    clock,
    processExecutor,
    policyReviewer: options.policyReviewer,
  });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "frontier-coordinator-fixture-"));
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@example.test");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "source.txt"), "baseline\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "baseline");
  return root;
}

function configuredSpec(root: string, budget: RunSpec["budget"]): RunSpec {
  return { ...spec(root), budget };
}

async function eventLog(root: string) {
  return (await new LocalRunStore(root).load()).events;
}

function assertExperimentLifecycle(events: readonly import("../src/index.ts").RunEvent[], experimentId: string, evaluated = true): void {
  for (const type of ["assignment-recorded", "worker-finished", "node-recorded", "frontier-updated", "experiment-finished"] as const) {
    assert.equal(events.filter((event) => event.type === type && event.experimentId === experimentId).length, 1, type);
  }
  assert.equal(events.filter((event) => event.type === "evaluation-recorded" && event.experimentId === experimentId).length, evaluated ? 1 : 0, "evaluation-recorded");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  return {
    promise: new Promise<void>((done) => (resolve = done)),
    resolve: () => resolve?.(),
  };
}

class HangingAfterAppendStore implements StoreAdapter {
  readonly #delegate: LocalRunStore;
  readonly #event: import("../src/index.ts").RunEventType;
  readonly persisted = deferred();
  readonly release = deferred();
  #hung = false;

  constructor(root: string, event: import("../src/index.ts").RunEventType) {
    this.#delegate = new LocalRunStore(root);
    this.#event = event;
  }

  claimInitialisation(specification: RunSpec): Promise<import("../src/index.ts").StoreInitialisationClaim> {
    return this.#delegate.claimInitialisation(specification);
  }

  initialise(
    specification: RunSpec,
    state: import("../src/index.ts").RunState,
    claim: import("../src/index.ts").StoreInitialisationClaim,
  ): Promise<void> {
    return this.#delegate.initialise(specification, state, claim);
  }

  writeGeneratedSpec(content: string): Promise<void> {
    return this.#delegate.writeGeneratedSpec(content);
  }

  async append(event: import("../src/index.ts").RunEvent): Promise<void> {
    await this.#delegate.append(event);
    if (!this.#hung && event.type === this.#event && event.experimentId === "experiment-0001") {
      this.#hung = true;
      this.persisted.resolve();
      await this.release.promise;
    }
  }

  snapshot(state: import("../src/index.ts").RunState): Promise<void> {
    return this.#delegate.snapshot(state);
  }

  load(): Promise<{ events: readonly import("../src/index.ts").RunEvent[]; snapshot?: import("../src/index.ts").RunState }> {
    return this.#delegate.load();
  }

  hasRunArtifacts(): Promise<boolean> {
    return this.#delegate.hasRunArtifacts();
  }

  clear(): Promise<void> {
    return this.#delegate.clear();
  }

  writeWorkerMarker(marker: import("../src/index.ts").WorkerMarker): Promise<void> {
    return this.#delegate.writeWorkerMarker(marker);
  }

  readWorkerMarker(): Promise<import("../src/index.ts").WorkerMarker | undefined> {
    return this.#delegate.readWorkerMarker();
  }

  clearWorkerMarker(): Promise<void> {
    return this.#delegate.clearWorkerMarker();
  }
}

class HangingWorkerMarkerStore implements StoreAdapter {
  readonly #delegate: LocalRunStore;
  readonly persisted = deferred();
  readonly release = deferred();

  constructor(root: string) {
    this.#delegate = new LocalRunStore(root);
  }

  claimInitialisation(specification: RunSpec): Promise<import("../src/index.ts").StoreInitialisationClaim> {
    return this.#delegate.claimInitialisation(specification);
  }

  initialise(
    specification: RunSpec,
    state: import("../src/index.ts").RunState,
    claim: import("../src/index.ts").StoreInitialisationClaim,
  ): Promise<void> {
    return this.#delegate.initialise(specification, state, claim);
  }

  writeGeneratedSpec(content: string): Promise<void> {
    return this.#delegate.writeGeneratedSpec(content);
  }

  append(event: import("../src/index.ts").RunEvent): Promise<void> {
    return this.#delegate.append(event);
  }

  snapshot(state: import("../src/index.ts").RunState): Promise<void> {
    return this.#delegate.snapshot(state);
  }

  load(): Promise<{ events: readonly import("../src/index.ts").RunEvent[]; snapshot?: import("../src/index.ts").RunState }> {
    return this.#delegate.load();
  }

  hasRunArtifacts(): Promise<boolean> {
    return this.#delegate.hasRunArtifacts();
  }

  clear(): Promise<void> {
    return this.#delegate.clear();
  }

  async writeWorkerMarker(marker: import("../src/index.ts").WorkerMarker): Promise<void> {
    await this.#delegate.writeWorkerMarker(marker);
    this.persisted.resolve();
    await this.release.promise;
  }

  readWorkerMarker(): Promise<import("../src/index.ts").WorkerMarker | undefined> {
    return this.#delegate.readWorkerMarker();
  }

  clearWorkerMarker(): Promise<void> {
    return this.#delegate.clearWorkerMarker();
  }
}

async function checkoutSnapshot(root: string): Promise<{ head: string; status: string; files: Readonly<Record<string, string>> }> {
  const files = (await git(root, "ls-files", "-z")).split("\0").filter(Boolean);
  return {
    head: await git(root, "rev-parse", "HEAD"),
    status: await git(root, "status", "--porcelain"),
    files: Object.fromEntries(await Promise.all(files.map(async (file) => [file, (await readFile(join(root, file))).toString("base64")] as const))),
  };
}

async function assertCheckoutUnchanged(root: string, before: Awaited<ReturnType<typeof checkoutSnapshot>>): Promise<void> {
  assert.deepEqual(await checkoutSnapshot(root), before);
}

async function benchmarkRepository(): Promise<string> {
  const root = await repository();
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "score.txt"), "100\n");
  await writeFile(join(root, "benchmark.mjs"), [
    'import { readFileSync } from "node:fs";',
    'const score = Number(readFileSync("src/score.txt", "utf8").trim());',
    'if (!Number.isFinite(score)) process.exit(2);',
    'console.log(`METRIC score=${score}`);',
  ].join("\n"));
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "add local benchmark");
  return root;
}

class BenchmarkWorker implements WorkerAdapter {
  readonly scores: readonly number[];
  calls = 0;
  active = 0;
  maximumActive = 0;
  assignments: string[] = [];

  constructor(scores: readonly number[]) {
    this.scores = scores;
  }

  async run(
    _specification: RunSpec,
    assignment: import("../src/index.ts").Assignment,
    worktree: import("../src/index.ts").WorktreeHandle,
    _signal?: AbortSignal,
    onProcessGroup?: (identity: ProcessGroupIdentity) => void | Promise<void>,
  ): Promise<WorkerOutcome> {
    const index = this.calls++;
    this.assignments.push(assignment.operator);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      await onProcessGroup?.(processIdentity(800 + index));
      await writeFile(join(worktree.path, "src", "score.txt"), `${this.scores[index]}\n`);
      await writeFile(join(worktree.path, "src", `candidate-${index + 1}.txt`), `${"change\n".repeat(index === 0 ? 5 : 1)}`);
      return {
        status: "submitted",
        stdout: "local fake worker",
        stderr: "",
        submission: {
          hypothesis: `Improve local score to ${this.scores[index]}`,
          change: "Edit the committed local benchmark input",
          expectedEffect: "Increase deterministic benchmark score",
          reflection: "Try another local score and source file",
          ...(assignment.operator === "crossover" ? { donorIdea: "Carry one complementary local change" } : {}),
        },
      };
    } finally {
      this.active -= 1;
    }
  }
}

test("concurrent coordinators atomically claim one empty local run before calibration", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const barrier = { arrived: 0, ready: deferred(), release: deferred() };
  const clocks = [new ManualClock(1_000), new ManualClock(1_000)];
  const processes = clocks.map((clock) => new ConcurrentConfigureProcess(clock, barrier));
  const stores = [new LocalRunStore(root), new LocalRunStore(root)];
  const runs = processes.map((processExecutor, index) => new RunCoordinator({
    store: stores[index]!,
    workspace: new GitWorkspaceAdapter({
      repository: root,
      runId: "coordinator-fixture",
      processExecutor,
    }),
    worker: new FailingWorker(),
    evaluator: trustedEvaluator({}),
    clock: clocks[index]!,
    processExecutor,
  }));

  const configuring = runs.map((run) => run.configure(spec(root)));
  await barrier.ready.promise;
  barrier.release.resolve();
  const results = await Promise.allSettled(configuring);
  const succeeded = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  const resultDetail = results.map((result) => result.status === "fulfilled" ? "fulfilled" : String(result.reason)).join("\n");
  assert.equal(succeeded.length, 1, resultDetail);
  assert.equal(rejected.length, 1, resultDetail);
  assert.match(String(rejected[0]?.reason), /durable run state already exists.*clear/i);
  assert.equal(processes.reduce((total, process) => total + process.calibrationRuns, 0), 1);

  const loaded = await new LocalRunStore(root).load();
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.events[0]?.type, "run-configured");
  const persistedSpec = JSON.parse(await readFile(join(root, ".frontier-autoresearch", "config.json"), "utf8")) as RunSpec;
  assert.deepEqual(persistedSpec, loaded.events[0]?.type === "run-configured" ? loaded.events[0].data.spec : undefined);
  await assert.rejects(() => access(join(root, ".frontier-autoresearch", "initialising.json")));

  const replayed = coordinator(root, new FailingWorker(), new ManualClock(2_000));
  assert.equal((await replayed.recover()).status, "configured");
});

test("a crashed initialisation claim is fail-closed, clearable, and preserves uncertain markers", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalRunStore(root);
  await store.claimInitialisation(spec(root));
  assert.equal(await store.hasRunArtifacts(), true);
  await assert.rejects(
    () => coordinator(root, new FailingWorker(), new ManualClock(1_000)).configure(spec(root)),
    /durable run state already exists.*clear/i,
  );

  const clearing = coordinator(root, new FailingWorker(), new ManualClock(1_000));
  await clearing.clear(true);
  assert.equal(await store.hasRunArtifacts(), false);
  await clearing.clear(true);

  await store.claimInitialisation(spec(root));
  await store.writeWorkerMarker({ experimentId: "uncertain-initialisation" });
  await assert.rejects(() => clearing.clear(true), /clear refused.*worker ownership.*preserved/i);
  assert.equal(await store.hasRunArtifacts(), true);
  assert.deepEqual(await store.readWorkerMarker(), { experimentId: "uncertain-initialisation" });

  await writeFile(join(root, ".frontier-autoresearch", "worker.json"), "{corrupt marker");
  await assert.rejects(() => clearing.clear(true), /Unexpected token|JSON/);
  assert.equal(await store.hasRunArtifacts(), true, "corrupt ownership state must survive refused clear");
});

test("coordinator records an experiment boundary before a sequential worker launch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "frontier-coordinator-red-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@example.test");
  await writeFile(join(root, "source.txt"), "baseline\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "baseline");
  const mainBefore = await git(root, "rev-parse", "HEAD");

  const clock = new ManualClock(1_000);
  const coordinator = new RunCoordinator({
    store: new LocalRunStore(root),
    workspace: new GitWorkspaceAdapter({ repository: root, runId: "coordinator-fixture" }),
    worker: new FailingWorker(),
    evaluator: {
      async calibrate(config) {
        return evaluation(`baseline:${config.runId}`, 100);
      },
      async evaluate(_config, candidate) {
        return evaluation(candidate.id, 101);
      },
    },
    clock,
  });

  await coordinator.configure(spec(root));
  await coordinator.start();
  await waitFor(() => coordinator.status().status === "completed", "coordinator to reach its budget boundary");

  const state = coordinator.status();
  assert.equal(state.status, "completed");
  assert.equal(state.budgetUsage.experiments, 1);
  assert.ok(Object.values(state.nodes).some((node) => node.operator === "baseline"));
  assert.equal(await git(root, "rev-parse", "HEAD"), mainBefore);
  assert.equal(await readFile(join(root, "source.txt"), "utf8"), "baseline\n");
  const events = (await new LocalRunStore(root).load()).events;
  const originalEvents = structuredClone(events);
  await assert.rejects(
    () => coordinator.configure(spec(root)),
    /durable run state already exists.*clear/i,
  );
  assert.deepEqual((await new LocalRunStore(root).load()).events, originalEvents);
  const replayed = new RunCoordinator({
    store: new LocalRunStore(root),
    workspace: new GitWorkspaceAdapter({ repository: root, runId: "coordinator-fixture" }),
    worker: new FailingWorker(),
    evaluator: trustedEvaluator({}),
    clock: new ManualClock(1_000),
  });
  assert.equal((await replayed.recover()).status, "completed", "the original history remains replayable");
  const failed = events.find((event) => event.type === "node-recorded" && event.experimentId === "experiment-0001");
  assert.equal(failed?.type, "node-recorded");
  if (failed?.type === "node-recorded") assert.equal(failed.data.node.outcome, "failed");
  assert.equal((await coordinator.recover()).status, "completed");
  const boundary = events.findIndex((event) => event.type === "assignment-recorded");
  const finished = events.findIndex((event) => event.type === "worker-finished");
  assert.ok(boundary >= 0 && boundary < finished);
});

test("evaluator failure leaves the main checkout unchanged", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const worker = new ScriptedWorker();
  const evaluator: EvaluatorAdapter = {
    async calibrate(config) { return evaluation(`baseline:${config.runId}`, 100); },
    async evaluate() { throw new Error("fixture evaluator failure"); },
  };
  const run = coordinator(root, worker, clock, { evaluator });
  const runSpec = configuredSpec(root, { maxExperiments: 1 });
  runSpec.editableGlobs = ["source.txt", "src/**"];
  const before = await checkoutSnapshot(root);
  await run.configure(runSpec);
  await run.start();
  await waitFor(() => run.status().status === "completed", "evaluator failure completion");
  assert.equal(run.status().nodes["experiment-0001"]?.outcome, "failed");
  await assertCheckoutUnchanged(root, before);
});

test("end-to-end coordinator runs six generic local benchmark experiments through the real Evaluator", async (t) => {
  const root = await benchmarkRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const processExecutor = new NodeProcessExecutor(clock);
  const workspace = new GitWorkspaceAdapter({ repository: root, runId: "coordinator-fixture", processExecutor });
  const worker = new BenchmarkWorker([110, 109, 108, 111, 107, 112]);
  const evaluator = new Evaluator({ commandExecutor: processExecutor, workspace });
  const run = new RunCoordinator({
    store: new LocalRunStore(root),
    workspace,
    worker,
    evaluator,
    clock,
    processExecutor,
  });
  const runSpec = configuredSpec(root, { maxExperiments: 6 });
  runSpec.evaluator = { command: "node benchmark.mjs", timeoutMs: 1_000 };
  runSpec.editableGlobs = ["src/**"];
  runSpec.protectedPaths = ["benchmark.mjs"];
  runSpec.confirmation = { maxSamples: 2, confidenceMultiplier: 1 };
  runSpec.frontierPolicy = { ...runSpec.frontierPolicy, crossoverCadence: 2, diverseNoveltyThreshold: 0.1 };
  const before = await checkoutSnapshot(root);

  await run.configure(runSpec);
  await run.start();
  await waitFor(() => ["completed", "failed"].includes(run.status().status), "six generic local benchmark experiments");

  const state = run.status();
  assert.equal(state.status, "completed", JSON.stringify(state));
  const runEvents = await eventLog(root);
  const evaluations = runEvents.filter((event) => event.type === "evaluation-recorded");
  assert.equal(state.budgetUsage.experiments, 6);
  for (let experiment = 1; experiment <= 6; experiment += 1) {
    assertExperimentLifecycle(runEvents, `experiment-${String(experiment).padStart(4, "0")}`);
  }
  assert.equal(worker.calls, 6);
  assert.equal(worker.maximumActive, 1);
  assert.ok(worker.assignments.includes("mutation"));
  assert.ok(worker.assignments.includes("crossover"));
  assert.ok(new Set(state.frontier.map((slot) => slot.role)).size >= 2);
  assert.ok(evaluations.some((event) => event.type === "evaluation-recorded" && event.data.evaluation.confirmationAttempted));
  assert.ok(evaluations.some((event) => event.type === "evaluation-recorded" && event.data.evaluation.evidence?.confirmation?.outcome === "confirmed"));
  assert.ok(state.frontier.some((slot) => slot.role === "BEST"));
  assert.ok(state.frontier.some((slot) => slot.role === "LEAN" || slot.role === "DIVERSE"));
  await assertCheckoutUnchanged(root, before);
});

test("budget limits stop before the next assignment and unlimited mode needs an explicit choice", async (t) => {
  const cases = [
    { name: "max-experiment", budget: { maxExperiments: 1 }, worker: new ScriptedWorker(), expected: /Experiment budget/ },
    { name: "wall-time", budget: { maxWallTimeMs: 5 }, worker: undefined, expected: /Wall-time budget/ },
    { name: "reported-cost", budget: { maxReportedCostUsd: 2 }, worker: undefined, expected: /Reported-cost budget/ },
  ] as const;
  for (const item of cases) {
    const root = await repository();
    t.after(() => rm(root, { recursive: true, force: true }));
    const clock = new ManualClock(1_000);
    const worker = item.worker ?? new ScriptedWorker({
      ...(item.name === "wall-time" ? { clock } : {}),
      ...(item.name === "reported-cost" ? { reportedCost: 2 } : {}),
    });
    const run = coordinator(root, worker, clock, { evaluator: trustedEvaluator({ "experiment-0001": 101 }) });
    await run.configure(configuredSpec(root, item.budget));
    await run.start();
    await waitFor(() => run.status().status === "completed", `${item.name} budget`);
    assert.equal(worker.calls, 1, item.name);
    assert.match(run.status().latestDecision ?? "", item.expected);
    assert.equal((await eventLog(root)).filter((event) => event.type === "assignment-recorded").length, 1);
  }

  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const worker = new BlockingWorker();
  const run = coordinator(root, worker, clock, { evaluator: trustedEvaluator({ "experiment-0001": 101 }) });
  await run.configure(configuredSpec(root, { unlimited: true }));
  await run.start();
  await waitFor(() => worker.started, "unlimited worker start");
  assert.equal(run.status().status, "running");
  const paused = run.pause();
  worker.release();
  await paused;
  assert.equal(run.status().status, "paused");
});

test("recovery rebuilds a missing snapshot, ignores a truncated JSONL tail, and resumes each persisted boundary exactly once", async (t) => {
  const phases = [
    { name: "before evaluation", event: "node-recorded", evaluates: true },
    { name: "after evaluation", event: "evaluation-recorded", evaluates: false },
    { name: "after frontier persistence", event: "frontier-updated", evaluates: false },
  ] as const;
  for (const phase of phases) {
    const root = await repository();
    t.after(() => rm(root, { recursive: true, force: true }));
    const initialClock = new ManualClock(1_000);
    const initialWorker = new ScriptedWorker();
    const initial = coordinator(root, initialWorker, initialClock, { evaluator: trustedEvaluator({ "experiment-0001": 101 }) });
    const initialSpec = configuredSpec(root, { maxExperiments: 1 });
    initialSpec.editableGlobs = ["source.txt", "src/**"];
    await initial.configure(initialSpec);
    await initial.start();
    await waitFor(() => initial.status().status === "completed", `initial ${phase.name} fixture`);

    const events = await eventLog(root);
    const cutoff = events.findIndex((event) => event.type === phase.event && event.experimentId === "experiment-0001");
    assert.ok(cutoff >= 0, phase.name);
    await writeFile(
      join(root, ".frontier-autoresearch", "events.jsonl"),
      `${events.slice(0, cutoff + 1).map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    await rm(join(root, ".frontier-autoresearch", "snapshot.json"));

    const gates: Array<string | undefined> = [];
    const recoveredWorker = new ScriptedWorker();
    const recovered = coordinator(root, recoveredWorker, new ManualClock(1_000), {
      evaluator: trustedEvaluator({ "experiment-0001": 101 }, gates),
    });
    await recovered.recover();
    await waitFor(() => recovered.status().status === "completed", `recovered ${phase.name} fixture`);
    assert.equal(recoveredWorker.calls, 0, `${phase.name} must not relaunch a committed worker`);
    assert.equal(gates.length > 0, phase.evaluates, `${phase.name}: ${JSON.stringify(gates)}`);
    const recoveredEvents = await eventLog(root);
    assertExperimentLifecycle(recoveredEvents, "experiment-0001");
    const finished = recoveredEvents.filter((event) => event.type === "experiment-finished");
    assert.equal(finished.filter((event) => event.experimentId === "experiment-0001").length, 1, JSON.stringify(finished));
  }

  const truncatedRoot = await repository();
  t.after(() => rm(truncatedRoot, { recursive: true, force: true }));
  const truncated = coordinator(truncatedRoot, new FailingWorker(), new ManualClock(1_000));
  const truncatedBefore = await checkoutSnapshot(truncatedRoot);
  await truncated.configure(configuredSpec(truncatedRoot, { maxExperiments: 1 }));
  await appendFile(join(truncatedRoot, ".frontier-autoresearch", "events.jsonl"), "{\"index\":");
  const rebuilt = coordinator(truncatedRoot, new FailingWorker(), new ManualClock(1_000));
  assert.equal((await rebuilt.recover()).status, "configured");
  await assertCheckoutUnchanged(truncatedRoot, truncatedBefore);
});

test("recovery cleans stale worktrees and trusts a stale marker's committed candidate", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const initial = coordinator(root, new ScriptedWorker(), clock, { evaluator: trustedEvaluator({ "experiment-0001": 101 }) });
  const initialSpec = configuredSpec(root, { maxExperiments: 1 });
  initialSpec.editableGlobs = ["source.txt", "src/**"];
  await initial.configure(initialSpec);
  await initial.start();
  await waitFor(() => initial.status().status === "completed", "orphan fixture completion");
  const events = await eventLog(root);
  const assignmentIndex = events.findIndex((event) => event.type === "assignment-recorded");
  await writeFile(
    join(root, ".frontier-autoresearch", "events.jsonl"),
    `${events.slice(0, assignmentIndex + 1).map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  await rm(join(root, ".frontier-autoresearch", "snapshot.json"));
  await writeFile(
    join(root, ".frontier-autoresearch", "worker.json"),
    JSON.stringify({ experimentId: "experiment-0001", process: processIdentity(444) }),
  );

  const workspace = new GitWorkspaceAdapter({ repository: root, runId: "coordinator-fixture" });
  const head = await git(root, "rev-parse", "HEAD");
  const stale = await workspace.materialise(
    { experimentId: "stale", operator: "mutation", primaryParentId: "baseline", hypothesis: "stale", policyVersion: 1 },
    {
      id: "baseline",
      commit: head,
      ref: "refs/pi-frontier-autoresearch/coordinator-fixture/nodes/baseline",
      parentIds: [],
      operator: "baseline",
      hypothesis: "baseline",
      reflection: "baseline",
      diffSummary: { changedFiles: [], changedLines: 0 },
      metricSamples: {},
      guardResults: [],
      outcome: "promoted",
      policyVersion: 1,
      createdEventIndex: 0,
      selection: { attempts: 0, promotions: 0 },
    },
  );
  const processes = new RecordingProcess(clock);
  const recovered = coordinator(root, new ScriptedWorker(), clock, {
    evaluator: trustedEvaluator({}),
    processExecutor: processes,
  });
  await recovered.recover();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(recovered.status().status, "completed", JSON.stringify({ state: recovered.status(), events: await eventLog(root) }));
  assert.deepEqual(processes.terminated, [444]);
  const interrupted = (await eventLog(root)).find((event) => event.type === "node-recorded" && event.experimentId === "experiment-0001");
  assert.equal(interrupted?.type, "node-recorded");
  if (interrupted?.type === "node-recorded") assert.notEqual(interrupted.data.node.outcome, "interrupted");
  assert.equal((await workspace.listWorktrees()).includes(stale.path), false);
});

test("command router uses a fake Pi, reports status, and requires confirmation before clear", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const configured = coordinator(root, new FailingWorker(), new ManualClock(1_000));
  const reusableSpec = configuredSpec(root, { maxExperiments: 1 });
  await configured.configure(reusableSpec);
  await configured.start();
  await waitFor(() => configured.status().status === "completed", "clear fixture completion");
  const runNamespace = "refs/pi-frontier-autoresearch/coordinator-fixture/";
  assert.notEqual(await git(root, "for-each-ref", "--format=%(refname)", runNamespace), "");
  const outsideRef = "refs/pi-frontier-autoresearch/another-run/nodes/keep";
  await git(root, "update-ref", outsideRef, await git(root, "rev-parse", "HEAD"));

  const commands = new Map<string, { handler: (args: string, context: unknown) => Promise<void> }>();
  const notices: Array<{ message: string; level: string }> = [];
  let confirm = false;
  const fakePi = {
    registerCommand(name: string, command: { handler: (args: string, context: unknown) => Promise<void> }) {
      commands.set(name, command);
    },
    registerTool() {},
    getActiveTools: () => ["read"],
    setActiveTools() {},
    sendUserMessage() {},
    on() {},
  } as unknown as ExtensionAPI;
  frontierAutoresearch(fakePi);
  const context = {
    cwd: root,
    hasUI: true,
    ui: {
      async confirm() { return confirm; },
      notify(message: string, level: string) { notices.push({ message, level }); },
    },
  };

  await commands.get("autoresearch")!.handler("status", context);
  assert.match(notices.at(-1)!.message, /Run coordinator-fixture: completed/);
  await commands.get("autoresearch")!.handler("clear", context);
  assert.match(notices.at(-1)!.message, /Clear cancelled/);
  assert.ok((await eventLog(root)).length > 0);
  confirm = true;
  await commands.get("autoresearch")!.handler("clear", context);
  assert.equal((await eventLog(root)).length, 0);
  assert.equal(await git(root, "for-each-ref", "--format=%(refname)", runNamespace), "");
  assert.equal(await git(root, "rev-parse", "--verify", outsideRef), await git(root, "rev-parse", "HEAD"));
  await assert.rejects(() => access(join(root, ".frontier-autoresearch")));
  const formerSiblingDirectory = [".pi", "frontier-autoresearch"].join("-");
  await assert.rejects(() => access(join(root, formerSiblingDirectory)));

  await configured.clear(true);
  await configured.clear(true);
  assert.equal(await git(root, "rev-parse", "--verify", outsideRef), await git(root, "rev-parse", "HEAD"));
  await assert.rejects(() => access(join(root, ".frontier-autoresearch")));
  const alreadyEmpty = coordinator(root, new FailingWorker(), new ManualClock(1_500));
  await alreadyEmpty.clear(true);
  assert.equal(await git(root, "rev-parse", "--verify", outsideRef), await git(root, "rev-parse", "HEAD"));

  const rerun = coordinator(root, new FailingWorker(), new ManualClock(2_000));
  await rerun.configure(reusableSpec);
  await rerun.start();
  await waitFor(() => rerun.status().status === "completed", "same-runId rerun completion");
  assert.equal(rerun.status().budgetUsage.experiments, 1);
  assertExperimentLifecycle(await eventLog(root), "experiment-0001", false);
});

test("coordinator concurrent pause and stop lifecycle calls serialize run events without deadlocking the worker loop", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const worker = new BlockingWorker();
  const processes = new RecordingProcess(clock);
  const run = coordinator(root, worker, clock, {
    evaluator: trustedEvaluator({ "experiment-0001": 101 }),
    processExecutor: processes,
  });
  await run.configure(configuredSpec(root, { maxExperiments: 1 }));

  const starts = await Promise.allSettled([run.start(), run.start()]);
  assert.equal(starts.filter((result) => result.status === "fulfilled").length, 1);
  await waitFor(() => worker.started, "concurrently started worker");
  const calls = await Promise.allSettled([
    run.pause(),
    run.stop("Concurrent stop."),
    run.pause(),
    Promise.resolve(run.status()),
    run.recover(),
  ]);
  assert.ok(calls.every((result) => result.status === "fulfilled" || result.reason instanceof Error));
  const events = await eventLog(root);
  assert.equal(events.filter((event) => event.type === "run-started").length, 1);
  assert.equal(events.filter((event) => event.type === "stop-requested").length, 1);
  assert.deepEqual(events.map((event) => event.index), events.map((_event, index) => index + 1));
  assert.equal(run.status().status, "stopped");
});

test("coordinator stop after assignment persistence records an interruption before any worker spawn", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const store = new HangingWorkerMarkerStore(root);
  const worker = new ScriptedWorker();
  const run = coordinator(root, worker, clock, { store, evaluator: trustedEvaluator({ "experiment-0001": 101 }) });
  const before = await checkoutSnapshot(root);
  await run.configure(configuredSpec(root, { maxExperiments: 1 }));
  await run.start();
  await store.persisted.promise;
  const stopping = run.stop("Stop before spawn.");
  store.release.resolve();
  await stopping;

  const events = await eventLog(root);
  const node = events.find((event) => event.type === "node-recorded" && event.experimentId === "experiment-0001");
  assert.equal(worker.calls, 0);
  assert.equal(run.status().status, "stopped");
  assert.equal(node?.type, "node-recorded");
  if (node?.type === "node-recorded") assert.equal(node.data.node.outcome, "interrupted");
  assert.equal(events.filter((event) => event.type === "experiment-finished" && event.experimentId === "experiment-0001").length, 1);
  await assertCheckoutUnchanged(root, before);
});

test("recovery at live worker, evaluation, and frontier boundaries never duplicates work", async (t) => {
  const phases = [
    { event: "worker-finished" as const, expectedEvaluations: 1 },
    { event: "evaluation-recorded" as const, expectedEvaluations: 1 },
    { event: "frontier-updated" as const, expectedEvaluations: 1 },
  ];
  for (const phase of phases) {
    const root = await repository();
    t.after(() => rm(root, { recursive: true, force: true }));
    const clock = new ManualClock(1_000);
    const store = new HangingAfterAppendStore(root, phase.event);
    const evaluator = {
      calls: 0,
      async calibrate(config: RunSpec) { return evaluation(`baseline:${config.runId}`, 100); },
      async evaluate(_config: RunSpec, candidate: import("../src/index.ts").NodeRecord, _parent: import("../src/index.ts").NodeRecord, gate: import("../src/index.ts").PromotionGate) {
        this.calls += 1;
        gate({ candidate, initialEvaluation: evaluation(candidate.id, 101, false) });
        return evaluation(candidate.id, 101);
      },
    } satisfies EvaluatorAdapter & { calls: number };
    const initialWorker = new ScriptedWorker();
    const initial = coordinator(root, initialWorker, clock, { store, evaluator });
    const runSpec = configuredSpec(root, { maxExperiments: 1 });
    runSpec.editableGlobs = ["source.txt", "src/**"];
    const before = await checkoutSnapshot(root);
    await initial.configure(runSpec);
    await initial.start();
    await store.persisted.promise;
    // Release the adapter after fencing the original controller. This is a dead
    // controller boundary, not a permanently hung loop or surviving fake worker.
    await initial.disposeForRecovery();
    store.release.resolve();

    const processes = new RecordingProcess(clock);
    const recoveredWorker = new ScriptedWorker();
    const recovered = coordinator(root, recoveredWorker, clock, { evaluator, processExecutor: processes });
    await recovered.recover();
    await waitFor(() => recovered.status().status === "completed", `recover live ${phase.event} boundary`);
    const events = await eventLog(root);
    assert.equal(initialWorker.calls, 1, phase.event);
    assert.equal(recoveredWorker.calls, 0, phase.event);
    assert.equal(evaluator.calls, phase.expectedEvaluations, phase.event);
    assertExperimentLifecycle(events, "experiment-0001");
    // The worker's group had already been confirmed and its marker cleared before
    // this later controller crash boundary, so recovery must not signal a raw PGID.
    assert.deepEqual(processes.confirmed, [], phase.event);
    await assertCheckoutUnchanged(root, before);
  }
});

test("recovery fails closed for a worker marker without a process group", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const store = new HangingWorkerMarkerStore(root);
  const initial = coordinator(root, new ScriptedWorker(), clock, { store, evaluator: trustedEvaluator({}) });
  const before = await checkoutSnapshot(root);
  await initial.configure(configuredSpec(root, { maxExperiments: 1 }));
  await initial.start();
  await store.persisted.promise;

  const worker = new ScriptedWorker();
  const workspace = new GitWorkspaceAdapter({ repository: root, runId: "coordinator-fixture" });
  let cleanupCalls = 0;
  const actualRecover = workspace.recover.bind(workspace);
  workspace.recover = async () => {
    cleanupCalls += 1;
    await actualRecover();
  };
  const recovered = new RunCoordinator({
    store: new LocalRunStore(root),
    workspace,
    worker,
    evaluator: trustedEvaluator({}),
    clock,
  });
  const state = await recovered.recover();
  assert.equal(state.status, "failed");
  assert.match(state.latestDecision ?? "", /requires intervention.*no durable process identity/i);
  assert.equal(worker.calls, 0);
  assert.equal(cleanupCalls, 0);
  assert.deepEqual(await new LocalRunStore(root).readWorkerMarker(), { experimentId: "experiment-0001" });
  await assert.rejects(
    () => recovered.clear(true),
    /clear refused.*worker ownership.*preserved/i,
  );
  assert.ok((await eventLog(root)).length > 0, "an unconfirmed marker must preserve durable history");
  assert.deepEqual(await new LocalRunStore(root).readWorkerMarker(), { experimentId: "experiment-0001" });
  assert.equal(cleanupCalls, 0);
  await assertCheckoutUnchanged(root, before);
});

test("recovery terminates a stale worker marker then evaluates its committed candidate exactly once", async (t) => {
  const root = await benchmarkRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const store = new HangingAfterAppendStore(root, "node-recorded");
  const initialProcess = new NodeProcessExecutor(clock);
  const initialWorkspace = new GitWorkspaceAdapter({ repository: root, runId: "coordinator-fixture", processExecutor: initialProcess });
  const initial = new RunCoordinator({
    store,
    workspace: initialWorkspace,
    worker: new BenchmarkWorker([110]),
    evaluator: new Evaluator({ commandExecutor: initialProcess, workspace: initialWorkspace }),
    clock,
    processExecutor: initialProcess,
  });
  const runSpec = configuredSpec(root, { maxExperiments: 1 });
  runSpec.evaluator = { command: "node benchmark.mjs", timeoutMs: 1_000 };
  runSpec.editableGlobs = ["src/**"];
  runSpec.protectedPaths = ["benchmark.mjs"];
  runSpec.confirmation = { maxSamples: 2, confidenceMultiplier: 1 };
  const before = await checkoutSnapshot(root);
  await initial.configure(runSpec);
  await initial.start();
  await store.persisted.promise;
  await initial.disposeForRecovery();
  store.release.resolve();
  // The old controller reached a durable node boundary after its fake worker was
  // gone. Reintroduce a live-identity marker to exercise stale-marker recovery.
  await new LocalRunStore(root).writeWorkerMarker({ experimentId: "experiment-0001", process: processIdentity(800) });

  const processes = new RecordingProcess(clock);
  const recoveryOrder: string[] = [];
  const confirmGroup = processes.terminateRecoveredProcessGroupAndWait.bind(processes);
  processes.terminateRecoveredProcessGroupAndWait = async (identity, timeoutMs) => {
    recoveryOrder.push("process-group-exited");
    return await confirmGroup(identity, timeoutMs);
  };
  const workspace = new GitWorkspaceAdapter({ repository: root, runId: "coordinator-fixture", processExecutor: processes });
  const cleanup = workspace.recover.bind(workspace);
  workspace.recover = async () => {
    recoveryOrder.push("workspace-cleanup");
    await cleanup();
  };
  const worker = new BenchmarkWorker([999]);
  const recovered = new RunCoordinator({
    store: new LocalRunStore(root),
    workspace,
    worker,
    evaluator: new Evaluator({ commandExecutor: processes, workspace }),
    clock,
    processExecutor: processes,
  });
  await recovered.recover();
  await waitFor(() => recovered.status().status === "completed", "stale-marker trusted evaluation");
  const events = await eventLog(root);
  const candidate = events.find((event) => event.type === "node-recorded" && event.experimentId === "experiment-0001");
  const evaluations = events.filter((event) => event.type === "evaluation-recorded" && event.experimentId === "experiment-0001");
  assert.equal(worker.calls, 0);
  assert.deepEqual(processes.confirmed, [800]);
  assert.deepEqual(recoveryOrder.slice(0, 2), ["process-group-exited", "workspace-cleanup"]);
  assert.equal(await new LocalRunStore(root).readWorkerMarker(), undefined);
  assert.equal(candidate?.type, "node-recorded");
  if (candidate?.type === "node-recorded") assert.notEqual(candidate.data.node.outcome, "interrupted");
  assertExperimentLifecycle(events, "experiment-0001");
  assert.equal(evaluations.length, 1);
  if (evaluations[0]?.type === "evaluation-recorded") {
    assert.equal(evaluations[0].data.evaluation.confirmationAttempted, true);
    assert.equal(evaluations[0].data.evaluation.evidence?.confirmation?.outcome, "confirmed");
  }
  await assertCheckoutUnchanged(root, before);
});

test("coordinator pause waits for a boundary and stop terminates the owned worker process group", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const pausedWorker = new BlockingWorker();
  const pausedRun = coordinator(root, pausedWorker, clock, { evaluator: trustedEvaluator({ "experiment-0001": 101 }) });
  await pausedRun.configure(configuredSpec(root, { maxExperiments: 2 }));
  await pausedRun.start();
  await waitFor(() => pausedWorker.started, "worker to start before pause");
  let pauseResolved = false;
  const pausing = pausedRun.pause().then(() => (pauseResolved = true));
  await Promise.resolve();
  assert.equal(pauseResolved, false);
  pausedWorker.release();
  await pausing;
  const pausedEvents = await eventLog(root);
  assert.equal(pausedRun.status().status, "paused");
  assert.ok(pausedEvents.findIndex((event) => event.type === "experiment-finished") < pausedEvents.findIndex((event) => event.type === "run-paused"));
  await pausedRun.resume();
  await waitFor(() => pausedRun.status().status === "completed", "resumed run completion");
  const resumedAssignments = (await eventLog(root))
    .filter((event) => event.type === "assignment-recorded")
    .map((event) => event.data.assignment.experimentId);
  assert.deepEqual(resumedAssignments, ["experiment-0001", "experiment-0002"]);
  assert.equal(pausedWorker.calls, 2);

  const stoppedRoot = await repository();
  t.after(() => rm(stoppedRoot, { recursive: true, force: true }));
  const stoppedClock = new ManualClock(1_000);
  const stoppedWorker = new BlockingWorker();
  const processes = new RecordingProcess(stoppedClock);
  const stoppedRun = coordinator(stoppedRoot, stoppedWorker, stoppedClock, {
    evaluator: trustedEvaluator({ "experiment-0001": 101 }),
    processExecutor: processes,
  });
  await stoppedRun.configure(configuredSpec(stoppedRoot, { maxExperiments: 2 }));
  await stoppedRun.start();
  await waitFor(() => stoppedWorker.started, "worker to start before stop");
  const confirmation = deferred();
  processes.terminationGate = confirmation.promise;
  const stopping = stoppedRun.stop("Stop fixture.");
  await processes.terminationStarted.promise;
  assert.equal(stoppedRun.status().status, "stopping");
  assert.deepEqual(await new LocalRunStore(stoppedRoot).readWorkerMarker(), {
    experimentId: "experiment-0001",
    process: processIdentity(321),
  });
  assert.equal((await eventLog(stoppedRoot)).some((event) => event.type === "run-stopped"), false);
  confirmation.resolve();
  await stopping;
  assert.deepEqual(processes.terminated, [321]);
  assert.deepEqual(processes.confirmed, [321]);
  assert.equal(stoppedRun.status().status, "stopped");
  const stoppedEvents = await eventLog(stoppedRoot);
  const stoppedNode = stoppedEvents.find((event) => event.type === "node-recorded" && event.experimentId === "experiment-0001");
  assert.equal(stoppedNode?.type, "node-recorded");
  if (stoppedNode?.type === "node-recorded") assert.equal(stoppedNode.data.node.outcome, "interrupted");
  const confirmationIndex = processes.confirmed.indexOf(321);
  const stoppedIndex = stoppedEvents.findIndex((event) => event.type === "run-stopped");
  assert.ok(confirmationIndex >= 0 && stoppedIndex >= 0);
  assert.ok(stoppedEvents.some((event) => event.type === "run-stopped"));
});

test("concurrent stop actively terminates descendants while a passive group-exit wait is in progress", async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    t.skip("POSIX process groups are only exercised on macOS and Linux");
    return;
  }
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const processes = new PassiveWaitRaceProcess(clock);
  const worker = new DescendantExitWorker(processes);
  const run = coordinator(root, worker, clock, {
    evaluator: trustedEvaluator({}),
    processExecutor: processes,
  });
  const configured = configuredSpec(root, { maxExperiments: 1 });
  configured.editableGlobs = ["source.txt", "src/**"];
  await run.configure(configured);
  await run.start();
  await processes.passiveWaitStarted.promise;
  const identity = worker.identity;
  assert.ok(identity);
  let groupExitConfirmed = false;
  try {
    process.kill(-identity.processGroupId, 0);
    const stopping = run.stop("Stop passive-wait race.");
    await waitFor(() => processes.terminated.includes(identity.processGroupId), "active stop termination");
    // `stop()` itself must signal the descendant-only group and wait for it to go;
    // the passive callback remains deliberately fenced below.
    await waitForProcessGroupExit(identity.processGroupId, "descendant group exit from stop");
    groupExitConfirmed = true;
    processes.releasePassiveWait();
    await stopping;
    assert.equal(run.status().status, "stopped");
    assert.equal(await new LocalRunStore(root).readWorkerMarker(), undefined);
  } finally {
    processes.releasePassiveWait();
    // Emergency cleanup is permitted only when the assertion/timeout above failed.
    if (!groupExitConfirmed) {
      try {
        process.kill(-identity.processGroupId, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
});

test("strict recovery does not signal a descendant-only group with a missing leader", async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    t.skip("POSIX process groups are only exercised on macOS and Linux");
    return;
  }
  const executor = new NodeProcessExecutor(new ManualClock(1_000));
  let identity: ProcessGroupIdentity | undefined;
  await executor.run({
    command: process.execPath,
    args: ["-e", "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 500)'], { stdio: 'ignore' }); setTimeout(() => process.exit(0), 10);"],
    cwd: process.cwd(),
    onProcessGroup: (reported) => { identity = reported; },
  });
  assert.ok(identity);
  const group = identity;
  assert.equal(await executor.isProcessGroupIdentityCurrent(group), false);
  assert.equal(await executor.terminateRecoveredProcessGroupAndWait(group, 100), false);
  // The descendant remains alive, proving strict recovery did not signal its PGID.
  assert.doesNotThrow(() => process.kill(-group.processGroupId, 0));
  await waitForProcessGroupExit(group.processGroupId, "naturally exiting strict-recovery fixture group");
});

test("recovery refuses a reused process identity without signalling or cleaning", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = coordinator(root, new ScriptedWorker(), new ManualClock(1_000), {
    evaluator: trustedEvaluator({ "experiment-0001": 101 }),
  });
  const configured = configuredSpec(root, { maxExperiments: 1 });
  configured.editableGlobs = ["source.txt", "src/**"];
  await initial.configure(configured);
  await initial.start();
  await waitFor(() => initial.status().status === "completed", "initial recovery fixture");
  const events = await eventLog(root);
  const assignmentIndex = events.findIndex((event) => event.type === "assignment-recorded");
  await writeFile(join(root, ".frontier-autoresearch", "events.jsonl"), `${events.slice(0, assignmentIndex + 1).map((event) => JSON.stringify(event)).join("\n")}\n`);
  await rm(join(root, ".frontier-autoresearch", "snapshot.json"));
  const marker = { experimentId: "experiment-0001", process: processIdentity(777) };
  await writeFile(join(root, ".frontier-autoresearch", "worker.json"), JSON.stringify(marker));

  const processes = new RecordingProcess(new ManualClock(1_000));
  processes.identityCurrent = false;
  const workspace = new GitWorkspaceAdapter({ repository: root, runId: "coordinator-fixture", processExecutor: processes });
  let cleanupCalls = 0;
  const recoverWorkspace = workspace.recover.bind(workspace);
  workspace.recover = async () => {
    cleanupCalls += 1;
    await recoverWorkspace();
  };
  const recovered = new RunCoordinator({
    store: new LocalRunStore(root),
    workspace,
    worker: new ScriptedWorker(),
    evaluator: trustedEvaluator({}),
    clock: new ManualClock(1_000),
    processExecutor: processes,
  });

  const state = await recovered.recover();
  assert.equal(state.status, "failed");
  assert.match(state.latestDecision ?? "", /identity.*absent or mismatched/i);
  assert.deepEqual(processes.checked, [777]);
  assert.deepEqual(processes.terminated, []);
  assert.equal(cleanupCalls, 0);
  assert.deepEqual(await new LocalRunStore(root).readWorkerMarker(), marker);
  await assert.rejects(
    () => recovered.clear(true),
    /clear refused.*worker ownership.*preserved/i,
  );
  assert.deepEqual(processes.terminated, []);
  assert.equal(cleanupCalls, 0);
  assert.deepEqual(await new LocalRunStore(root).readWorkerMarker(), marker);
  assert.ok((await eventLog(root)).length > 0);
});

test("stop fails closed when owned group exit cannot be confirmed", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const worker = new BlockingWorker();
  const processes = new RecordingProcess(clock);
  processes.terminationConfirmed = false;
  const run = coordinator(root, worker, clock, { evaluator: trustedEvaluator({}), processExecutor: processes });
  await run.configure(configuredSpec(root, { maxExperiments: 1 }));
  await run.start();
  await waitFor(() => worker.started, "worker before unconfirmed stop");
  await run.stop("Require confirmed exit.");

  const events = await eventLog(root);
  assert.equal(run.status().status, "failed");
  assert.deepEqual(processes.terminated, [321]);
  assert.deepEqual(processes.confirmed, []);
  assert.equal(events.some((event) => event.type === "run-stopped"), false);
  assert.equal(events.some((event) => event.type === "node-recorded" && event.experimentId === "experiment-0001"), false);
  assert.deepEqual(await new LocalRunStore(root).readWorkerMarker(), {
    experimentId: "experiment-0001",
    process: processIdentity(321),
    processExited: true,
    status: "cancelled",
    reason: "cancelled",
  });
});

test("recovery replays durable worker cost exactly once before evaluating a persisted candidate", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const workspace = new GitWorkspaceAdapter({ repository: root, runId: "coordinator-fixture" });
  const persisted = deferred();
  const releasePersistence = deferred();
  const persistNode = workspace.persistNode.bind(workspace);
  let held = false;
  workspace.persistNode = async (node) => {
    await persistNode(node);
    if (!held && node.id === "experiment-0001") {
      held = true;
      persisted.resolve();
      await releasePersistence.promise;
    }
    return workspace.recordRef(node.id);
  };
  const initial = new RunCoordinator({
    store: new LocalRunStore(root),
    workspace,
    worker: new ScriptedWorker({ reportedCost: 1.25 }),
    evaluator: trustedEvaluator({ "experiment-0001": 101 }),
    clock,
    processExecutor: new RecordingProcess(clock),
  });
  const configured = configuredSpec(root, { maxExperiments: 2, maxReportedCostUsd: 1.25 });
  configured.editableGlobs = ["source.txt", "src/**"];
  await initial.configure(configured);
  await initial.start();
  await persisted.promise;
  const durable = await workspace.readNodeRecord("experiment-0001");
  assert.equal(durable.reportedCostUsd, 1.25);
  assert.equal((await eventLog(root)).some((event) => event.type === "worker-finished"), false);
  assert.deepEqual(await new LocalRunStore(root).readWorkerMarker(), {
    experimentId: "experiment-0001",
    process: processIdentity(901),
    processExited: true,
    reportedCostUsd: 1.25,
    status: "submitted",
  });

  // Release the injected persistence hold only after disabling this coordinator,
  // modelling process/session death without retaining a hidden live loop.
  await initial.disposeForRecovery();
  releasePersistence.resolve();
  await new Promise((resolve) => setTimeout(resolve, 25));

  const recoveryClock = new ManualClock(1_000);
  const processes = new RecordingProcess(recoveryClock);
  const recoveredWorker = new ScriptedWorker();
  const recovered = coordinator(root, recoveredWorker, recoveryClock, {
    evaluator: trustedEvaluator({ "experiment-0001": 101 }),
    processExecutor: processes,
  });
  await recovered.recover();
  await waitFor(() => recovered.status().status === "completed", "cost-accounted recovery completion");

  const events = await eventLog(root);
  const workerFinished = events.filter((event) => event.type === "worker-finished" && event.experimentId === "experiment-0001");
  assertExperimentLifecycle(events, "experiment-0001");
  assert.equal(recoveredWorker.calls, 0);
  assert.equal(recovered.status().budgetUsage.reportedCostUsd, 1.25);
  assert.match(recovered.status().latestDecision ?? "", /Reported-cost budget reached/);
  assert.equal(workerFinished[0]?.type, "worker-finished");
  if (workerFinished[0]?.type === "worker-finished") assert.equal(workerFinished[0].data.reportedCostUsd, 1.25);
  assert.deepEqual(processes.confirmed, []);
  assert.equal(await new LocalRunStore(root).readWorkerMarker(), undefined);
});

test("worker marker survives candidate metadata verification and recovers exact billed cost", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const workspace = new GitWorkspaceAdapter({ repository: root, runId: "coordinator-fixture" });
  const verificationStarted = deferred();
  const releaseVerification = deferred();
  const verifyGitMetadata = workspace.verifyGitMetadata.bind(workspace);
  workspace.verifyGitMetadata = async (worktree) => {
    verificationStarted.resolve();
    await releaseVerification.promise;
    return await verifyGitMetadata(worktree);
  };
  const initial = new RunCoordinator({
    store: new LocalRunStore(root),
    workspace,
    worker: new ScriptedWorker({ reportedCost: 1.25 }),
    evaluator: trustedEvaluator({ "experiment-0001": 101 }),
    clock,
    processExecutor: new RecordingProcess(clock),
  });
  const configured = configuredSpec(root, { maxExperiments: 2, maxReportedCostUsd: 1.25 });
  configured.editableGlobs = ["source.txt", "src/**"];
  await initial.configure(configured);
  await initial.start();
  await verificationStarted.promise;
  assert.equal((await eventLog(root)).some((event) => event.type === "worker-finished"), false);
  assert.deepEqual(await new LocalRunStore(root).readWorkerMarker(), {
    experimentId: "experiment-0001",
    process: processIdentity(901),
    processExited: true,
    reportedCostUsd: 1.25,
    status: "submitted",
  });
  await assert.rejects(() => workspace.readNodeRecord("experiment-0001"));

  await initial.disposeForRecovery();
  const recoveryClock = new ManualClock(1_000);
  const recovered = coordinator(root, new ScriptedWorker(), recoveryClock, {
    evaluator: trustedEvaluator({}),
    processExecutor: new RecordingProcess(recoveryClock),
  });
  await recovered.recover();
  await waitFor(() => recovered.status().status === "completed", "metadata-gap recovery completion");
  const events = await eventLog(root);
  const workerFinished = events.filter((event) => event.type === "worker-finished" && event.experimentId === "experiment-0001");
  assertExperimentLifecycle(events, "experiment-0001", false);
  assert.equal(workerFinished.length, 1);
  assert.equal(workerFinished[0]?.type, "worker-finished");
  if (workerFinished[0]?.type === "worker-finished") {
    assert.equal(workerFinished[0].data.status, "interrupted");
    assert.equal(workerFinished[0].data.reportedCostUsd, 1.25);
  }
  assert.equal(recovered.status().budgetUsage.reportedCostUsd, 1.25);
  assert.match(recovered.status().latestDecision ?? "", /Reported-cost budget reached/);
  assert.equal(await new LocalRunStore(root).readWorkerMarker(), undefined);

  // The fenced old candidate now sees recovery's worktree cleanup and cannot write.
  releaseVerification.resolve();
  await new Promise((resolve) => setTimeout(resolve, 25));
});

test("POSIX identity rejects a live leader whose actual PGID mismatches the recorded group", async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    t.skip("POSIX process groups are only exercised on macOS and Linux");
    return;
  }
  const executor = new NodeProcessExecutor(new ManualClock(1_000));
  const abort = new AbortController();
  let identity: ProcessGroupIdentity | undefined;
  const running = executor.run({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1_000)"],
    cwd: process.cwd(),
    onProcessGroup: (reported) => { identity = reported; },
  }, abort.signal);
  await waitFor(() => identity !== undefined, "live POSIX leader identity");
  const live = identity!;
  const mismatched = { ...live, processGroupId: live.processGroupId + 1_000_000_000 };
  try {
    // A process-group leader cannot move groups on POSIX; this forged PGID must
    // fail closed even though the PID and start identity still name the live leader.
    assert.equal(await executor.isProcessGroupIdentityCurrent(mismatched), false);
    await executor.terminateRecoveredProcessGroupAndWait(mismatched, 100);
    process.kill(live.leaderPid, 0);
  } finally {
    abort.abort();
    await running;
  }
});

test("real POSIX recovery confirms the owned group is gone before workspace cleanup", async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    t.skip("POSIX process groups are only exercised on macOS and Linux");
    return;
  }
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const processExecutor = new NodeProcessExecutor(clock);
  const worker = new LocalPosixBlockingWorker(processExecutor);
  const initialWorkspace = new GitWorkspaceAdapter({ repository: root, runId: "coordinator-fixture", processExecutor });
  const initial = new RunCoordinator({
    store: new LocalRunStore(root),
    workspace: initialWorkspace,
    worker,
    evaluator: trustedEvaluator({}),
    clock,
    processExecutor,
  });
  const configured = configuredSpec(root, { maxExperiments: 1 });
  configured.editableGlobs = ["source.txt", "src/**"];
  await initial.configure(configured);
  await initial.start();
  await waitFor(() => worker.groupReported && worker.identity !== undefined, "real worker group marker");
  const identity = worker.identity!;

  // Keep the worker adapter's post-exit continuation fenced until recovery is over;
  // this models session death without a permanently hung coordinator or child process.
  await initial.disposeForRecovery();
  worker.abandonForRecovery();
  const recoveryWorkspace = new GitWorkspaceAdapter({ repository: root, runId: "coordinator-fixture", processExecutor });
  const recoverWorkspace = recoveryWorkspace.recover.bind(recoveryWorkspace);
  let cleanupAfterConfirmedExit = false;
  recoveryWorkspace.recover = async () => {
    try {
      process.kill(-identity.processGroupId, 0);
      assert.fail("workspace cleanup ran while the owned process group was still live");
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
    }
    cleanupAfterConfirmedExit = true;
    await recoverWorkspace();
  };
  const recovered = new RunCoordinator({
    store: new LocalRunStore(root),
    workspace: recoveryWorkspace,
    worker: new ScriptedWorker(),
    evaluator: trustedEvaluator({}),
    clock: new ManualClock(1_000),
    processExecutor,
  });
  await recovered.recover();
  await waitFor(() => recovered.status().status === "completed", "real POSIX recovery completion");

  assert.equal(cleanupAfterConfirmedExit, true);
  assertExperimentLifecycle(await eventLog(root), "experiment-0001", false);
  try {
    process.kill(-identity.processGroupId, 0);
    assert.fail("owned worker process group survived recovery");
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
  }
  worker.release();
  await new Promise((resolve) => setTimeout(resolve, 25));

  const clearRoot = await repository();
  t.after(() => rm(clearRoot, { recursive: true, force: true }));
  const clearProcess = new NodeProcessExecutor(new ManualClock(2_000));
  const clearWorker = new LocalPosixBlockingWorker(clearProcess);
  const clearInitial = new RunCoordinator({
    store: new LocalRunStore(clearRoot),
    workspace: new GitWorkspaceAdapter({ repository: clearRoot, runId: "coordinator-fixture", processExecutor: clearProcess }),
    worker: clearWorker,
    evaluator: trustedEvaluator({}),
    clock: new ManualClock(2_000),
    processExecutor: clearProcess,
  });
  const clearSpec = configuredSpec(clearRoot, { maxExperiments: 1 });
  clearSpec.editableGlobs = ["source.txt", "src/**"];
  await clearInitial.configure(clearSpec);
  await clearInitial.start();
  await waitFor(() => clearWorker.groupReported && clearWorker.identity !== undefined, "post-crash clear worker marker");
  const clearIdentity = clearWorker.identity!;
  await clearInitial.disposeForRecovery();
  clearWorker.abandonForRecovery();

  const clearWorkspace = new GitWorkspaceAdapter({ repository: clearRoot, runId: "coordinator-fixture", processExecutor: clearProcess });
  const recoverBeforeClear = clearWorkspace.recover.bind(clearWorkspace);
  let clearCleanupAfterExit = false;
  clearWorkspace.recover = async () => {
    try {
      process.kill(-clearIdentity.processGroupId, 0);
      assert.fail("clear cleaned worktrees while the post-crash worker group was live");
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
    }
    clearCleanupAfterExit = true;
    await recoverBeforeClear();
  };
  const clearMustNotLaunch = new ScriptedWorker();
  const clearing = new RunCoordinator({
    store: new LocalRunStore(clearRoot),
    workspace: clearWorkspace,
    worker: clearMustNotLaunch,
    evaluator: trustedEvaluator({}),
    clock: new ManualClock(2_000),
    processExecutor: clearProcess,
  });
  try {
    await clearing.clear(true);
    assert.equal(clearCleanupAfterExit, true);
    assert.equal(clearMustNotLaunch.calls, 0);
    assert.equal((await eventLog(clearRoot)).length, 0);
    try {
      process.kill(-clearIdentity.processGroupId, 0);
      assert.fail("post-crash worker process group survived clear");
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
    }
  } finally {
    try {
      process.kill(-clearIdentity.processGroupId, "SIGTERM");
      await waitForProcessGroupExit(clearIdentity.processGroupId, "post-crash clear fixture cleanup");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    clearWorker.release();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
});

test("policy tuning launches a policy review only after a documented stalled run", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const reviewer = {
    calls: 0,
    async review() {
      this.calls += 1;
      return {
        status: "proposed" as const,
        stdout: "",
        stderr: "",
        proposal: {
          rationale: "Explore a little more novelty after repeated non-promotions.",
          changes: { noveltyWeight: 0.5 },
        },
      };
    },
  };
  const runSpec = configuredSpec(root, { maxExperiments: 4 });
  runSpec.editableGlobs = ["source.txt", "src/**"];
  runSpec.policyTuning = { enabled: true };
  const run = new RunCoordinator({
    store: new LocalRunStore(root),
    workspace: new GitWorkspaceAdapter({ repository: root, runId: "coordinator-fixture" }),
    worker: new ScriptedWorker(),
    evaluator: trustedEvaluator({
      "experiment-0001": 80,
      "experiment-0002": 80,
      "experiment-0003": 80,
      "experiment-0004": 80,
    }),
    clock,
    policyReviewer: reviewer,
  } as unknown as import("../src/index.ts").RunCoordinatorDependencies);

  await run.configure(runSpec);
  await run.start();
  await waitFor(() => ["completed", "failed"].includes(run.status().status), "stalled policy-tuning fixture completion");

  assert.equal(run.status().status, "completed", JSON.stringify(run.status()));
  assert.equal(reviewer.calls, 1);
  const events = await eventLog(root);
  const proposed = events.filter((event) => event.type === "policy-proposed");
  const updated = events.filter((event) => event.type === "policy-updated");
  assert.equal(proposed.length, 1);
  assert.equal(updated.length, 1);
  assert.equal(proposed[0]?.type, "policy-proposed");
  if (proposed[0]?.type === "policy-proposed") {
    assert.equal(proposed[0].data.accepted, true);
    assert.deepEqual(proposed[0].data.proposal, {
      rationale: "Explore a little more novelty after repeated non-promotions.",
      changes: { noveltyWeight: 0.5 },
    });
  }
  assert.equal(run.status().activePolicy.version, 2);
  assert.equal(run.status().activePolicy.weights.novelty, 0.5);

  const replayed = coordinator(root, new ScriptedWorker(), new ManualClock(1_000), {
    evaluator: trustedEvaluator({}),
    policyReviewer: reviewer,
  });
  const replayedState = await replayed.recover();
  assert.deepEqual(replayedState.activePolicy, run.status().activePolicy);
  assert.equal(replayedState.policyVersion, 2);

  const rolledBack = await replayed.rollbackPolicy(1);
  assert.equal(rolledBack.policyVersion, 3);
  assert.equal(rolledBack.activePolicy.weights.novelty, 0.35);
  const rollback = (await eventLog(root)).at(-1);
  assert.equal(rollback?.type, "policy-rolled-back");
  const replayedRollback = coordinator(root, new ScriptedWorker(), new ManualClock(1_000), {
    evaluator: trustedEvaluator({}),
    policyReviewer: reviewer,
  });
  assert.deepEqual((await replayedRollback.recover()).activePolicy, rolledBack.activePolicy);
});

test("policy review is disabled in fixed mode and rate-limited in opt-in mode", async (t) => {
  const fixedRoot = await repository();
  t.after(() => rm(fixedRoot, { recursive: true, force: true }));
  const fixedReviewer = {
    calls: 0,
    async review() {
      this.calls += 1;
      return { status: "failed" as const, stdout: "", stderr: "" };
    },
  };
  const fixedSpec = configuredSpec(fixedRoot, { maxExperiments: 4 });
  fixedSpec.editableGlobs = ["source.txt", "src/**"];
  const fixed = coordinator(fixedRoot, new ScriptedWorker(), new ManualClock(1_000), {
    evaluator: trustedEvaluator({
      "experiment-0001": 80,
      "experiment-0002": 80,
      "experiment-0003": 80,
      "experiment-0004": 80,
    }),
    policyReviewer: fixedReviewer,
  });
  await fixed.configure(fixedSpec);
  await fixed.start();
  await waitFor(() => fixed.status().status === "completed", "fixed-mode completion");
  assert.equal(fixedReviewer.calls, 0);
  assert.equal((await eventLog(fixedRoot)).some((event) => event.type === "policy-review-recorded"), false);

  const healthyRoot = await benchmarkRepository();
  t.after(() => rm(healthyRoot, { recursive: true, force: true }));
  const healthyReviewer = {
    calls: 0,
    async review() {
      this.calls += 1;
      return { status: "failed" as const, stdout: "", stderr: "" };
    },
  };
  const healthySpec = configuredSpec(healthyRoot, { maxExperiments: 4 });
  healthySpec.editableGlobs = ["source.txt", "src/**"];
  healthySpec.policyTuning = { enabled: true };
  const healthy = coordinator(healthyRoot, new BenchmarkWorker([101, 102, 103, 104]), new ManualClock(1_000), {
    evaluator: trustedEvaluator({
      "experiment-0001": 101,
      "experiment-0002": 102,
      "experiment-0003": 103,
      "experiment-0004": 104,
    }),
    policyReviewer: healthyReviewer,
  });
  await healthy.configure(healthySpec);
  await healthy.start();
  await waitFor(() => ["completed", "failed"].includes(healthy.status().status), "healthy opt-in completion");
  assert.equal(healthy.status().status, "completed", JSON.stringify(healthy.status()));
  assert.equal(healthyReviewer.calls, 0);

  const tunedRoot = await repository();
  t.after(() => rm(tunedRoot, { recursive: true, force: true }));
  const tunedReviewer = {
    calls: 0,
    async review() {
      this.calls += 1;
      return {
        status: "proposed" as const,
        stdout: "",
        stderr: "",
        proposal: {
          rationale: `Bounded retry ${this.calls}`,
          changes: { noveltyWeight: 0.35 + this.calls / 10 },
        },
      };
    },
  };
  const tunedSpec = configuredSpec(tunedRoot, { maxExperiments: 7 });
  tunedSpec.editableGlobs = ["source.txt", "src/**"];
  tunedSpec.policyTuning = { enabled: true };
  const tuned = coordinator(tunedRoot, new ScriptedWorker(), new ManualClock(1_000), {
    evaluator: trustedEvaluator({
      "experiment-0001": 80,
      "experiment-0002": 80,
      "experiment-0003": 80,
      "experiment-0004": 80,
      "experiment-0005": 80,
      "experiment-0006": 80,
      "experiment-0007": 80,
    }),
    policyReviewer: tunedReviewer,
  });
  await tuned.configure(tunedSpec);
  await tuned.start();
  await waitFor(() => ["completed", "failed"].includes(tuned.status().status), "rate-limited policy review completion");
  assert.equal(tuned.status().status, "completed", JSON.stringify(tuned.status()));
  assert.equal(tunedReviewer.calls, 2);
  const reviews = (await eventLog(tunedRoot)).filter((event) => event.type === "policy-review-recorded");
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews.map((event) => event.type === "policy-review-recorded" ? event.data.review.trigger : undefined), [
    "stall-no-promotions",
    "stall-no-promotions",
  ]);
});

test("policy review recognizes documented degeneration signals", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const reviewer = {
    calls: 0,
    async review() {
      this.calls += 1;
      return { status: "failed" as const, stdout: "", stderr: "", reason: "No bounded recommendation." };
    },
  };
  const runSpec = configuredSpec(root, { maxExperiments: 4 });
  runSpec.policyTuning = { enabled: true };
  const run = coordinator(root, new FailingWorker(), new ManualClock(1_000), {
    evaluator: trustedEvaluator({}),
    policyReviewer: reviewer,
  });
  await run.configure(runSpec);
  await run.start();
  await waitFor(() => run.status().status === "completed", "degeneration policy-review completion");
  assert.equal(reviewer.calls, 1);
  const review = (await eventLog(root)).find((event) => event.type === "policy-review-recorded");
  assert.equal(review?.type, "policy-review-recorded");
  if (review?.type === "policy-review-recorded") {
    assert.equal(review.data.review.trigger, "degeneration-terminal-outcomes");
  }
});

test("policy review recovery terminates durable ownership before resuming at a boundary", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new ManualClock(1_000);
  const processes = new RecordingProcess(clock);
  const release = deferred();
  const reviewer = {
    started: false,
    async review(
      _context: import("../src/index.ts").PolicyReviewContext,
      _signal?: AbortSignal,
      onProcessGroup?: (identity: ProcessGroupIdentity) => void | Promise<void>,
    ) {
      this.started = true;
      await onProcessGroup?.(processIdentity(654));
      await release.promise;
      return {
        status: "proposed" as const,
        stdout: "",
        stderr: "",
        proposal: { rationale: "Late proposal must not be persisted.", changes: { noveltyWeight: 0.5 } },
      };
    },
  };
  const runSpec = configuredSpec(root, { maxExperiments: 4 });
  runSpec.editableGlobs = ["source.txt", "src/**"];
  runSpec.policyTuning = { enabled: true };
  const initial = coordinator(root, new ScriptedWorker(), clock, {
    evaluator: trustedEvaluator({
      "experiment-0001": 80,
      "experiment-0002": 80,
      "experiment-0003": 80,
    }),
    processExecutor: processes,
    policyReviewer: reviewer,
  });
  await initial.configure(runSpec);
  await initial.start();
  await waitFor(() => reviewer.started || initial.status().status === "failed", "durable policy-review worker marker");
  assert.equal(initial.status().status, "running", JSON.stringify(initial.status()));
  await initial.disposeForRecovery();

  const recoveredWorker = new ScriptedWorker();
  const recovered = coordinator(root, recoveredWorker, new ManualClock(1_000), {
    evaluator: trustedEvaluator({}),
    processExecutor: processes,
  });
  await recovered.recover();
  await waitFor(() => recovered.status().status === "completed", "policy-review recovery completion");
  const events = await eventLog(root);
  assert.deepEqual(processes.terminated, [654]);
  assert.equal(recoveredWorker.calls, 1);
  assert.equal(events.some((event) => event.type === "policy-proposed"), false);
  const finished = events.find((event) => event.type === "policy-review-finished");
  assert.equal(finished?.type, "policy-review-finished");
  if (finished?.type === "policy-review-finished") assert.equal(finished.data.status, "cancelled");
  assert.equal(await new LocalRunStore(root).readWorkerMarker(), undefined);
  release.resolve();
  await new Promise((resolve) => setTimeout(resolve, 25));
});

test("rebuild rejects policy-update version gaps and accepted-proposal mismatches before frontier replay", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const runSpec = configuredSpec(root, { maxExperiments: 4 });
  runSpec.editableGlobs = ["source.txt", "src/**"];
  runSpec.policyTuning = { enabled: true };
  const run = coordinator(root, new ScriptedWorker(), new ManualClock(1_000), {
    evaluator: trustedEvaluator({
      "experiment-0001": 80,
      "experiment-0002": 80,
      "experiment-0003": 80,
      "experiment-0004": 80,
    }),
    policyReviewer: {
      async review() {
        return {
          status: "proposed" as const,
          stdout: "",
          stderr: "",
          proposal: { rationale: "A bounded change.", changes: { noveltyWeight: 0.5 } },
        };
      },
    },
  });
  await run.configure(runSpec);
  await run.start();
  await waitFor(() => run.status().status === "completed", "policy update fixture completion");
  const original = await eventLog(root);

  for (const mutate of [
    (events: import("../src/index.ts").RunEvent[]) => {
      const update = events.find((event) => event.type === "policy-updated");
      assert.equal(update?.type, "policy-updated");
      if (update?.type === "policy-updated") {
        update.data.version = 3;
        update.data.policy.version = 3;
      }
    },
    (events: import("../src/index.ts").RunEvent[]) => {
      const update = events.find((event) => event.type === "policy-updated");
      assert.equal(update?.type, "policy-updated");
      if (update?.type === "policy-updated") update.data.previousVersion = 0;
    },
  ]) {
    const tampered = structuredClone(original) as import("../src/index.ts").RunEvent[];
    mutate(tampered);
    await writeFile(
      join(root, ".frontier-autoresearch", "events.jsonl"),
      `${tampered.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    await assert.rejects(
      () => coordinator(root, new ScriptedWorker(), new ManualClock(1_000)).recover(),
      /policy update.*version|policy update does not match/i,
    );
  }
});

test("production policy guard and reviewer durably reject forbidden, unknown, out-of-range, and invariant-breaking submissions", async (t) => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "frontier-policy-review-guarded-"));
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
  const fixture = join(fixtureDirectory, "pi");
  const script = join(fixtureDirectory, "guarded-reviewer.ts");
  await writeFile(fixture, `#!/bin/sh
exec ${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(script)} "$@"
`);
  await chmod(fixture, 0o755);
  const guardPath = resolve(process.cwd(), "extensions/pi-frontier-autoresearch/policy-review-guard.ts");
  const proposals: Readonly<Record<string, unknown>> = {
    malformed: null,
    evaluator: { rationale: "Do not do this", changes: { noveltyWeight: 0.5 }, evaluator: "other command" },
    guards: { rationale: "Do not do this", changes: { noveltyWeight: 0.5 }, guards: [] },
    budget: { rationale: "Do not do this", changes: { noveltyWeight: 0.5 }, budget: { unlimited: true } },
    frontierSize: { rationale: "Do not do this", changes: { noveltyWeight: 0.5 }, frontierSize: 8 },
    code: { rationale: "Do not do this", changes: { noveltyWeight: 0.5 }, code: "rewrite controller" },
    unknown: { rationale: "Unknown tunable", changes: { unknownWeight: 1 } },
    outOfRange: { rationale: "Unsafe value", changes: { noveltyWeight: 3 } },
    invariant: { rationale: "Break cadence invariant", changes: { crossoverCadence: 1.5 } },
  };
  for (const [name, proposal] of Object.entries(proposals)) {
    const root = await repository();
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(script, `
import policyReviewGuard from ${JSON.stringify(guardPath)};
const tools = new Map();
policyReviewGuard({
  registerTool(tool) { tools.set(tool.name, tool); },
  on() {},
  setActiveTools() {},
});
const result = await tools.get("policy_review_submit").execute("fixture", ${JSON.stringify(proposal)});
console.log(JSON.stringify({ type: "tool_result_end", message: { toolName: "policy_review_submit", details: result.details } }));
`);
    const reviewer = new PolicyReviewer({ executable: fixture, timeoutMs: 2_000 });
    const runSpec = configuredSpec(root, { maxExperiments: 4 });
    runSpec.editableGlobs = ["source.txt", "src/**"];
    runSpec.policyTuning = { enabled: true };
    const run = coordinator(root, new ScriptedWorker(), new ManualClock(1_000), {
      evaluator: trustedEvaluator({
        "experiment-0001": 80,
        "experiment-0002": 80,
        "experiment-0003": 80,
        "experiment-0004": 80,
      }),
      policyReviewer: reviewer,
    });
    await run.configure(runSpec);
    await run.start();
    await waitFor(() => ["completed", "failed"].includes(run.status().status), `${name} rejection completion`);
    assert.equal(run.status().status, "completed", name);
    assert.equal(run.status().policyVersion, 1, name);
    const events = await eventLog(root);
    const rejected = events.filter((event) => event.type === "policy-proposed");
    assert.equal(rejected.length, 1, name);
    assert.equal(rejected[0]?.type, "policy-proposed");
    if (rejected[0]?.type === "policy-proposed") {
      assert.equal(rejected[0].data.accepted, false, name);
      assert.equal((rejected[0].data.proposal as { kind?: string }).kind, "policy-proposal-rejected", name);
      assert.ok(Buffer.byteLength(JSON.stringify(rejected[0].data.proposal)) < 2_048, name);
      assert.match(rejected[0].data.reason, /object|unknown|within|integer/i, name);
    }
    assert.equal(events.some((event) => event.type === "policy-updated"), false, name);
  }
});
