import { isDeepStrictEqual } from "node:util";

import type {
  Assignment,
  Evaluation,
  FrontierPolicy,
  FrontierPolicyVersion,
  FrontierRole,
  FrontierSelectionWeights,
  FrontierSlot,
  MetricDirection,
  NodeRecord,
  PromotionGate,
} from "./contracts.ts";
import { DEFAULT_FRONTIER_SELECTION_WEIGHTS } from "./policy-tuning.ts";

export type { FrontierSelectionWeights } from "./contracts.ts";

export interface FrontierControllerConfig {
  primaryMetric: string;
  primaryDirection: MetricDirection;
  policy: FrontierPolicy;
  costMetric?: string;
  costDirection?: MetricDirection;
  weights?: Partial<FrontierSelectionWeights>;
  /** All accepted immutable versions, with version one first. */
  policyVersions?: readonly FrontierPolicyVersion[];
}

export interface ResolvedFrontierPolicy {
  version: number;
  primaryMetric: string;
  primaryDirection: MetricDirection;
  costMetric: string | null;
  costDirection: MetricDirection;
  frontier: FrontierPolicy;
  weights: FrontierSelectionWeights;
}

export interface FrontierSelectionScore {
  nodeId: string;
  productivity: number;
  exploration: number;
  novelty: number;
  coverage: number;
  recency: number;
  total: number;
}

export interface FrontierPolicyRecordedEvent {
  index: number;
  type: "policy-recorded";
  policy: ResolvedFrontierPolicy;
}

export interface FrontierAssignmentRecordedEvent {
  index: number;
  type: "assignment-recorded";
  assignment: Assignment;
  scores: readonly FrontierSelectionScore[];
  reason: string;
}

export interface FrontierEvaluationDecision {
  promoted: boolean;
  role?: FrontierRole;
  reason: string;
  novelty: number;
}

export interface FrontierEvaluationRecordedEvent {
  index: number;
  type: "evaluation-recorded";
  node: NodeRecord;
  evaluation?: Evaluation;
  result: "completed" | "rejected" | "failed" | "interrupted";
  failureReason?: string;
  frontier: readonly FrontierSlot[];
  decision: FrontierEvaluationDecision;
}

export type FrontierEvent =
  | FrontierPolicyRecordedEvent
  | FrontierAssignmentRecordedEvent
  | FrontierEvaluationRecordedEvent;

export interface FrontierNodeStatistics {
  attempts: number;
  promotions: number;
  lastSelectedEventIndex?: number;
}

export interface FrontierSnapshot {
  policy?: ResolvedFrontierPolicy;
  nodes: Readonly<Record<string, NodeRecord>>;
  evaluations: Readonly<Record<string, Evaluation>>;
  frontier: readonly FrontierSlot[];
  statistics: Readonly<Record<string, FrontierNodeStatistics>>;
  activeAssignment?: Assignment;
  lastEventIndex: number;
}

export interface RecordEvaluationInput {
  node: NodeRecord;
  evaluation?: Evaluation;
  failureReason?: string;
}

export interface NextAssignmentInput {
  experimentId?: string;
  hypothesis?: string;
  policyVersion?: number;
}


function assignmentParentIds(assignment: Assignment): string[] {
  return [assignment.primaryParentId, assignment.donorParentId]
    .filter((parentId): parentId is string => parentId !== undefined);
}

function canonicalChangedFiles(node: NodeRecord): string[] {
  return [...new Set(node.diffSummary.changedFiles)].sort((left, right) => left.localeCompare(right));
}

function fileNovelty(left: NodeRecord, right: NodeRecord): number {
  const leftFiles = new Set(canonicalChangedFiles(left));
  const rightFiles = new Set(canonicalChangedFiles(right));
  const union = new Set([...leftFiles, ...rightFiles]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const file of leftFiles) {
    if (rightFiles.has(file)) intersection += 1;
  }
  return (union.size - intersection) / union.size;
}

function minimumNovelty(candidate: NodeRecord, selected: readonly NodeRecord[]): number {
  if (selected.length === 0) return 1;
  return Math.min(...selected.map((node) => fileNovelty(candidate, node)));
}

function metricMedian(evaluation: Evaluation | undefined, metric: string): number | undefined {
  const value = evaluation?.summaries[metric]?.median;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compareMetric(left: number, right: number, direction: MetricDirection): number {
  return direction === "higher" ? right - left : left - right;
}

function isStrictlyBetter(candidate: number, incumbent: number, direction: MetricDirection): boolean {
  return direction === "higher" ? candidate > incumbent : candidate < incumbent;
}

function withinTolerance(
  candidate: number,
  best: number,
  direction: MetricDirection,
  tolerance: number,
): boolean {
  const regression = direction === "higher" ? best - candidate : candidate - best;
  return regression <= Math.max(Math.abs(best), Number.EPSILON) * tolerance;
}

function slotsFor(nodeIds: readonly string[], roles: readonly FrontierRole[]): FrontierSlot[] {
  return nodeIds.map((nodeId, index) => ({
    index: index as 0 | 1 | 2 | 3,
    role: roles[index]!,
    nodeId,
  }));
}

function hasEligibleEvaluation(evaluation: Evaluation | undefined, nodeId: string, primaryMetric: string): boolean {
  return (
    evaluation !== undefined &&
    evaluation.nodeId === nodeId &&
    evaluation.confirmed &&
    evaluation.scopeValid &&
    evaluation.protectedPathsIntact &&
    evaluation.guards.every((guard) => guard.status === "passed") &&
    metricMedian(evaluation, primaryMetric) !== undefined
  );
}

function resultFor(input: RecordEvaluationInput): FrontierEvaluationRecordedEvent["result"] {
  if (input.node.outcome === "interrupted") return "interrupted";
  if (input.node.outcome === "rejected") return "rejected";
  if (input.node.outcome === "failed" || !input.evaluation) return "failed";
  return "completed";
}

function assertNodeParentage(node: NodeRecord): void {
  if (new Set(node.parentIds).size !== node.parentIds.length) {
    throw new Error(`node ${node.id} has duplicate parents`);
  }
  const requiredParents = node.operator === "baseline" ? 0 : node.operator === "mutation" ? 1 : 2;
  if (node.parentIds.length !== requiredParents) {
    const labels = { baseline: "no", mutation: "one", crossover: "two" } as const;
    throw new Error(`a ${node.operator} node must have ${labels[node.operator]} parents`);
  }
}

function assertAssignmentParentage(assignment: Assignment): void {
  const parents = assignmentParentIds(assignment);
  const requiredParents = assignment.operator === "mutation" ? 1 : 2;
  if (parents.length !== requiredParents || new Set(parents).size !== parents.length) {
    throw new Error(`assignment ${assignment.experimentId} has invalid parentage`);
  }
}

function assignmentMatchesNode(assignment: Assignment, node: NodeRecord): boolean {
  return assignment.operator === node.operator && isDeepStrictEqual(assignmentParentIds(assignment), node.parentIds);
}

export class FrontierController {
  readonly config: FrontierControllerConfig;
  readonly weights: FrontierSelectionWeights;
  /** The newest accepted policy drives the next assignment. */
  readonly resolvedPolicy: ResolvedFrontierPolicy;
  readonly #initialPolicy: ResolvedFrontierPolicy;
  readonly #policies: ReadonlyMap<number, ResolvedFrontierPolicy>;

  constructor(config: FrontierControllerConfig) {
    if (!config.primaryMetric.trim()) throw new Error("primaryMetric must be non-empty");
    if (config.primaryDirection !== "higher" && config.primaryDirection !== "lower") {
      throw new Error("primaryDirection must be higher or lower");
    }
    if (config.costDirection !== undefined && config.costDirection !== "higher" && config.costDirection !== "lower") {
      throw new Error("costDirection must be higher or lower");
    }

    const configuredInitial: FrontierPolicyVersion = {
      version: 1,
      frontier: { ...config.policy },
      weights: { ...DEFAULT_FRONTIER_SELECTION_WEIGHTS, ...config.weights },
    };
    const versions = config.policyVersions === undefined ? [configuredInitial] : [...config.policyVersions];
    if (versions.length === 0 || versions[0]?.version !== 1) {
      throw new Error("policy history must begin at version one");
    }
    if (!isDeepStrictEqual(versions[0].frontier, configuredInitial.frontier)) {
      throw new Error("policy version one must match the configured frontier policy");
    }
    const resolved = new Map<number, ResolvedFrontierPolicy>();
    let previousVersion = 0;
    for (const version of versions) {
      if (!Number.isInteger(version.version) || version.version !== previousVersion + 1) {
        throw new Error("policy versions must increase contiguously");
      }
      previousVersion = version.version;
      if (version.frontier.size !== 4) throw new Error("frontier size must be four");
      for (const [name, value] of Object.entries({
        leanPrimaryTolerance: version.frontier.leanPrimaryTolerance,
        diversePrimaryTolerance: version.frontier.diversePrimaryTolerance,
        diverseNoveltyThreshold: version.frontier.diverseNoveltyThreshold,
      })) {
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          throw new Error(`${name} must be between zero and one`);
        }
      }
      if (!Number.isInteger(version.frontier.crossoverCadence) || version.frontier.crossoverCadence < 1) {
        throw new Error("crossoverCadence must be a positive integer");
      }
      for (const [name, value] of Object.entries(version.weights)) {
        if (!Number.isFinite(value) || value < 0) throw new Error(`${name} weight must be finite and non-negative`);
      }
      resolved.set(version.version, Object.freeze({
        version: version.version,
        primaryMetric: config.primaryMetric,
        primaryDirection: config.primaryDirection,
        costMetric: config.costMetric ?? null,
        costDirection: config.costDirection ?? "lower",
        frontier: Object.freeze({ ...version.frontier }),
        weights: Object.freeze({ ...version.weights }),
      }));
    }
    this.#policies = resolved;
    this.#initialPolicy = resolved.get(1)!;
    this.resolvedPolicy = resolved.get(previousVersion)!;
    this.weights = this.resolvedPolicy.weights;
    this.config = Object.freeze({
      primaryMetric: config.primaryMetric,
      primaryDirection: config.primaryDirection,
      policy: this.resolvedPolicy.frontier,
      costMetric: config.costMetric,
      costDirection: config.costDirection ?? "lower",
      weights: this.weights,
      policyVersions: versions.map((version) => structuredClone(version)),
    });
  }

  recordPolicy(): FrontierPolicyRecordedEvent {
    return {
      index: 0,
      type: "policy-recorded",
      policy: structuredClone(this.#initialPolicy),
    };
  }

  #policyFor(version: number): ResolvedFrontierPolicy {
    const policy = this.#policies.get(version);
    if (!policy) throw new Error(`policy version ${version} is an inactive policy version`);
    return policy;
  }

  replay(history: readonly FrontierEvent[]): FrontierSnapshot {
    const nodes: Record<string, NodeRecord> = {};
    const evaluations: Record<string, Evaluation> = {};
    const statistics: Record<string, FrontierNodeStatistics> = {};
    const validatedHistory: FrontierEvent[] = [];
    let frontier: readonly FrontierSlot[] = [];
    let previousIndex = -1;
    let pendingAssignment: Assignment | undefined;
    let activePolicy: ResolvedFrontierPolicy | undefined;
    // Roles persist under the policy that derived their transition. An assignment
    // can activate a newer policy before it has produced a new frontier event.
    let frontierPolicy: ResolvedFrontierPolicy | undefined;

    for (const event of history) {
      if (!Number.isInteger(event.index) || event.index !== previousIndex + 1) {
        throw new Error("frontier event indexes must increase monotonically without gaps");
      }
      previousIndex = event.index;

      if (event.type === "policy-recorded") {
        if (validatedHistory.length !== 0 || activePolicy) throw new Error("fixed policy must be the first event");
        if (!isDeepStrictEqual(event.policy, this.#initialPolicy)) {
          throw new Error("recorded policy does not match the active controller policy");
        }
        activePolicy = event.policy;
        frontierPolicy = event.policy;
        validatedHistory.push(event);
        continue;
      }
      if (!activePolicy) throw new Error("fixed policy must be recorded before frontier events");

      if (event.type === "assignment-recorded") {
        if (pendingAssignment) throw new Error(`assignment ${pendingAssignment.experimentId} has not been evaluated`);
        assertAssignmentParentage(event.assignment);
        const assignmentPolicy = this.#policyFor(event.assignment.policyVersion);
        const snapshot = this.snapshot(nodes, evaluations, frontier, statistics, undefined, previousIndex - 1, assignmentPolicy);
        const expected = this.planAssignment(snapshot, validatedHistory, {
          experimentId: event.assignment.experimentId,
          hypothesis: event.assignment.hypothesis,
          policyVersion: event.assignment.policyVersion,
        }, assignmentPolicy);
        if (!isDeepStrictEqual(event, expected)) {
          throw new Error(`assignment ${event.assignment.experimentId} does not match nextAssignment`);
        }
        activePolicy = assignmentPolicy;
        pendingAssignment = event.assignment;
        for (const parentId of assignmentParentIds(event.assignment)) {
          const parentStatistics = statistics[parentId] ??= { attempts: 0, promotions: 0 };
          parentStatistics.attempts += 1;
          parentStatistics.lastSelectedEventIndex = event.index;
        }
        validatedHistory.push(event);
        continue;
      }

      if (nodes[event.node.id]) throw new Error(`node ${event.node.id} is already in lineage`);
      assertNodeParentage(event.node);
      if (event.node.policyVersion !== activePolicy.version) {
        throw new Error(`node ${event.node.id} uses an inactive policy version`);
      }
      if (event.node.operator === "baseline") {
        if (pendingAssignment || Object.keys(nodes).length !== 0 || frontier.length !== 0) {
          throw new Error("baseline seeding is only valid as the first node");
        }
      } else {
        if (!pendingAssignment) throw new Error(`non-baseline node ${event.node.id} requires a pending assignment`);
        if (!assignmentMatchesNode(pendingAssignment, event.node)) {
          throw new Error(`candidate parentage does not match assignment ${pendingAssignment.experimentId}`);
        }
      }
      for (const parentId of event.node.parentIds) {
        if (!nodes[parentId]) throw new Error(`parent ${parentId} must precede node ${event.node.id}`);
      }
      const derived = this.deriveEvaluationEvent(
        this.snapshot(nodes, evaluations, frontier, statistics, pendingAssignment, event.index - 1, activePolicy),
        event.node,
        event.evaluation,
        event.result,
        event.failureReason,
      );
      if (!isDeepStrictEqual(event.frontier, derived.frontier)) {
        throw new Error(`node ${event.node.id} frontier transition does not match derived transition`);
      }
      if (!isDeepStrictEqual(event.decision, derived.decision)) {
        throw new Error(`node ${event.node.id} decision does not match derived transition`);
      }
      if (!isDeepStrictEqual(event.node, derived.node) || event.index !== derived.index) {
        throw new Error(`node ${event.node.id} record does not match derived transition`);
      }

      nodes[event.node.id] = event.node;
      statistics[event.node.id] ??= { attempts: 0, promotions: 0 };
      if (event.evaluation) evaluations[event.node.id] = event.evaluation;
      frontier = derived.frontier;
      frontierPolicy = activePolicy;
      if (derived.decision.promoted && pendingAssignment) {
        for (const parentId of assignmentParentIds(pendingAssignment)) {
          const parentStatistics = statistics[parentId] ??= { attempts: 0, promotions: 0 };
          parentStatistics.promotions += 1;
        }
      }
      pendingAssignment = undefined;
      validatedHistory.push(event);
    }

    if (history.length > 0 && !activePolicy) throw new Error("frontier history has no fixed policy event");
    const finalNodes = this.nodesWithStatistics(nodes, statistics);
    this.assertDerivedFrontier(frontier, finalNodes, evaluations, frontierPolicy);
    return {
      policy: activePolicy,
      nodes: finalNodes,
      evaluations,
      frontier,
      statistics,
      activeAssignment: pendingAssignment,
      lastEventIndex: previousIndex,
    };
  }

  /**
   * Return a pure gate bound to a validated, replayable frontier history.
   * The gate snapshots its input history so a later caller mutation cannot change the
   * decision made between initial measurement and paired confirmation.
   */
  createPromotionGate(history: readonly FrontierEvent[]): PromotionGate {
    const replayableHistory = structuredClone(history);
    this.replay(replayableHistory);
    return ({ candidate, initialEvaluation }) => this.previewPromotion(
      replayableHistory,
      candidate,
      initialEvaluation,
    ).role;
  }

  /**
   * Calculate the frontier role a guard-valid initial evaluation would occupy without
   * recording an event. Confirmation remains mandatory for recordEvaluation.
   */
  previewPromotion(
    history: readonly FrontierEvent[],
    candidate: NodeRecord,
    initialEvaluation: Evaluation,
  ): FrontierEvaluationDecision {
    const provisionalEvaluation = this.provisionallyConfirm(initialEvaluation, candidate.id);
    return this.recordEvaluation(history, { node: candidate, evaluation: provisionalEvaluation }).decision;
  }

  recordEvaluation(
    history: readonly FrontierEvent[],
    input: RecordEvaluationInput,
  ): FrontierEvaluationRecordedEvent {
    const snapshot = this.replay(history);
    if (!snapshot.policy) throw new Error("fixed policy must be recorded before frontier events");
    if (snapshot.nodes[input.node.id]) throw new Error(`node ${input.node.id} is already in lineage`);
    if (input.node.policyVersion !== snapshot.policy.version) {
      throw new Error(`node ${input.node.id} uses an inactive policy version`);
    }
    if (input.node.operator === "baseline") {
      assertNodeParentage(input.node);
      if (snapshot.activeAssignment || Object.keys(snapshot.nodes).length !== 0 || snapshot.frontier.length !== 0) {
        throw new Error("baseline seeding is only valid as the first node");
      }
    } else {
      if (!snapshot.activeAssignment) {
        throw new Error(`non-baseline node ${input.node.id} requires a pending assignment from nextAssignment`);
      }
      if (!assignmentMatchesNode(snapshot.activeAssignment, input.node)) {
        throw new Error(`candidate parentage does not match assignment ${snapshot.activeAssignment.experimentId}`);
      }
      assertNodeParentage(input.node);
    }
    for (const parentId of input.node.parentIds) {
      if (!snapshot.nodes[parentId]) throw new Error(`parent ${parentId} must precede node ${input.node.id}`);
    }
    return this.deriveEvaluationEvent(
      snapshot,
      input.node,
      input.evaluation,
      resultFor(input),
      input.failureReason,
    );
  }

  nextAssignment(
    history: readonly FrontierEvent[],
    input: NextAssignmentInput = {},
  ): FrontierAssignmentRecordedEvent {
    const snapshot = this.replay(history);
    if (!snapshot.policy) throw new Error("fixed policy must be recorded before frontier events");
    const policy = input.policyVersion === undefined ? this.resolvedPolicy : this.#policyFor(input.policyVersion);
    return this.planAssignment(snapshot, history, input, policy);
  }

  private provisionallyConfirm(evaluation: Evaluation, nodeId: string): Evaluation {
    const guardValid =
      evaluation.nodeId === nodeId &&
      evaluation.scopeValid &&
      evaluation.protectedPathsIntact &&
      evaluation.guards.every((guard) => guard.status === "passed");
    return guardValid ? { ...evaluation, confirmed: true } : evaluation;
  }

  private snapshot(
    nodes: Readonly<Record<string, NodeRecord>>,
    evaluations: Readonly<Record<string, Evaluation>>,
    frontier: readonly FrontierSlot[],
    statistics: Readonly<Record<string, FrontierNodeStatistics>>,
    activeAssignment: Assignment | undefined,
    lastEventIndex: number,
    policy: ResolvedFrontierPolicy,
  ): FrontierSnapshot {
    return {
      policy,
      nodes: this.nodesWithStatistics(nodes, statistics),
      evaluations,
      frontier,
      statistics,
      activeAssignment,
      lastEventIndex,
    };
  }

  private nodesWithStatistics(
    nodes: Readonly<Record<string, NodeRecord>>,
    statistics: Readonly<Record<string, FrontierNodeStatistics>>,
  ): Record<string, NodeRecord> {
    return Object.fromEntries(Object.entries(nodes).map(([nodeId, node]) => [
      nodeId,
      { ...node, selection: { ...(statistics[nodeId] ?? { attempts: 0, promotions: 0 }) } },
    ]));
  }

  private deriveEvaluationEvent(
    snapshot: FrontierSnapshot,
    submittedNode: NodeRecord,
    evaluation: Evaluation | undefined,
    result: FrontierEvaluationRecordedEvent["result"],
    failureReason: string | undefined,
  ): FrontierEvaluationRecordedEvent {
    const index = snapshot.lastEventIndex + 1;
    if (evaluation && evaluation.nodeId !== submittedNode.id) {
      throw new Error(`evaluation node ${evaluation.nodeId} does not match candidate ${submittedNode.id}`);
    }
    if (result !== "completed" && evaluation) {
      throw new Error(`${result} candidate ${submittedNode.id} cannot carry an evaluation`);
    }
    const eligible = result === "completed" && hasEligibleEvaluation(evaluation, submittedNode.id, this.config.primaryMetric);
    const candidate = { ...submittedNode, outcome: "pending" as const };
    const candidates = snapshot.frontier.map((slot) => snapshot.nodes[slot.nodeId]!);
    if (eligible) candidates.push(candidate);
    const evaluations: Record<string, Evaluation> = { ...snapshot.evaluations };
    if (evaluation) evaluations[submittedNode.id] = evaluation;
    const nextFrontier = this.recalculateRoles(candidates, evaluations, snapshot.policy!);
    const promotedSlot = nextFrontier.find((slot) => slot.nodeId === submittedNode.id);
    const outcome: NodeRecord["outcome"] = result === "interrupted"
      ? "interrupted"
      : result === "failed"
        ? "failed"
        : result === "rejected"
          ? "rejected"
          : promotedSlot
            ? "promoted"
            : "rejected";
    const recordedNode: NodeRecord = {
      ...submittedNode,
      outcome,
      policyVersion: snapshot.policy!.version,
      createdEventIndex: index,
      metricSamples: evaluation?.samples ?? submittedNode.metricSamples,
      guardResults: evaluation?.guards ?? submittedNode.guardResults,
      selection: { attempts: 0, promotions: 0 },
    };
    const comparisonNodes = nextFrontier
      .filter((slot) => slot.nodeId !== submittedNode.id)
      .map((slot) => snapshot.nodes[slot.nodeId])
      .filter((node): node is NodeRecord => node !== undefined);
    const novelty = minimumNovelty(recordedNode, comparisonNodes);
    const reason = result !== "completed"
      ? failureReason ?? (result === "interrupted"
        ? "candidate was interrupted"
        : result === "rejected"
          ? "candidate was already rejected"
          : "candidate did not complete")
      : !eligible
        ? evaluation?.reason ?? "candidate did not pass confirmation and guards"
        : promotedSlot
          ? `promoted as ${promotedSlot.role}`
          : "candidate did not improve a frontier role";
    const decision: FrontierEvaluationDecision = promotedSlot
      ? { promoted: true, role: promotedSlot.role, reason, novelty }
      : { promoted: false, reason, novelty };
    return {
      index,
      type: "evaluation-recorded",
      node: recordedNode,
      ...(evaluation ? { evaluation } : {}),
      result,
      ...(failureReason !== undefined ? { failureReason } : {}),
      frontier: nextFrontier,
      decision,
    };
  }

  private planAssignment(
    snapshot: FrontierSnapshot,
    history: readonly FrontierEvent[],
    input: NextAssignmentInput,
    policy: ResolvedFrontierPolicy = this.resolvedPolicy,
  ): FrontierAssignmentRecordedEvent {
    if (snapshot.frontier.length === 0) throw new Error("cannot select a parent from an empty frontier");
    if (snapshot.activeAssignment) {
      throw new Error(`assignment ${snapshot.activeAssignment.experimentId} has not been evaluated`);
    }
    if (input.policyVersion !== undefined && input.policyVersion !== policy.version) {
      throw new Error(`policy version ${input.policyVersion} is not active`);
    }
    const assignmentEvents = history.filter(
      (event): event is FrontierAssignmentRecordedEvent => event.type === "assignment-recorded",
    );
    const scores = this.selectionScores(snapshot, policy);
    const scoreById = new Map(scores.map((score) => [score.nodeId, score]));
    const lastAssignment = assignmentEvents.at(-1)?.assignment;
    const latestCrossoverOffset = assignmentEvents.findLastIndex(
      (event) => event.assignment.operator === "crossover",
    );
    const assignmentsSinceCrossover = latestCrossoverOffset < 0
      ? assignmentEvents.length
      : assignmentEvents.length - latestCrossoverOffset - 1;
    const freshBest = this.freshBest(history, snapshot.frontier[0]!.nodeId);
    const crossoverDue =
      snapshot.frontier.length > 1 &&
      assignmentsSinceCrossover >= policy.frontier.crossoverCadence - 1;
    const operator = snapshot.frontier.length > 1 && (freshBest !== undefined || crossoverDue)
      ? "crossover"
      : "mutation";

    let primaryParentId: string;
    let donorParentId: string | undefined;
    let reason: string;
    if (operator === "crossover") {
      const rankedPairs = this.rankPairs(snapshot, scoreById, assignmentEvents, lastAssignment, policy);
      const selected = freshBest
        ? rankedPairs.find((pair) => pair.primary === freshBest)
        : rankedPairs[0];
      if (!selected) throw new Error("cannot select two distinct crossover parents");
      primaryParentId = selected.primary;
      donorParentId = selected.donor;
      reason = freshBest
        ? `cross fresh BEST ${primaryParentId} with complementary parent ${donorParentId}`
        : `crossover cadence selected complementary parents ${primaryParentId} and ${donorParentId}`;
    } else {
      const previousParticipants = new Set(lastAssignment ? assignmentParentIds(lastAssignment) : []);
      const candidates = scores.filter(
        (score) => snapshot.frontier.length === 1 || !previousParticipants.has(score.nodeId),
      );
      primaryParentId = (candidates[0] ?? scores[0])!.nodeId;
      reason = lastAssignment
        ? `rotate mutation parent to ${primaryParentId}`
        : `select mutation parent ${primaryParentId}`;
    }

    const assignmentNumber = assignmentEvents.length + 1;
    const hypothesis = input.hypothesis ?? (operator === "crossover"
      ? `Transplant one complementary idea from ${donorParentId} into ${primaryParentId}.`
      : `Try one coherent mutation from ${primaryParentId}.`);
    const assignment: Assignment = {
      experimentId: input.experimentId ?? `experiment-${String(assignmentNumber).padStart(4, "0")}`,
      operator,
      primaryParentId,
      ...(donorParentId ? { donorParentId } : {}),
      hypothesis,
      policyVersion: policy.version,
    };
    return {
      index: snapshot.lastEventIndex + 1,
      type: "assignment-recorded",
      assignment,
      scores,
      reason,
    };
  }

  private selectionScores(snapshot: FrontierSnapshot, policy: ResolvedFrontierPolicy): FrontierSelectionScore[] {
    const nodes = snapshot.frontier.map((slot) => snapshot.nodes[slot.nodeId]!);
    const totalAttempts = Object.values(snapshot.statistics).reduce((sum, statistics) => sum + statistics.attempts, 0);
    const exploredDirections = new Map(nodes.map((node) => [node.id, new Set<string>()]));
    for (const candidate of Object.values(snapshot.nodes)) {
      const changedFiles = canonicalChangedFiles(candidate);
      if (changedFiles.length === 0) continue;
      const direction = changedFiles.join("\u0000");
      for (const parentId of candidate.parentIds) exploredDirections.get(parentId)?.add(direction);
    }
    return nodes
      .map((node) => {
        const statistics = snapshot.statistics[node.id] ?? { attempts: 0, promotions: 0 };
        const productivity = statistics.attempts === 0 ? 0 : statistics.promotions / statistics.attempts;
        const exploration = Math.sqrt(Math.log(totalAttempts + 2) / (statistics.attempts + 1));
        const others = nodes.filter((other) => other.id !== node.id);
        const novelty = others.length === 0
          ? 1
          : others.reduce((sum, other) => sum + fileNovelty(node, other), 0) / others.length;
        const coverage = 1 / (1 + (exploredDirections.get(node.id)?.size ?? 0));
        const recency = statistics.lastSelectedEventIndex === undefined
          ? 1
          : Math.min(
            1,
            Math.max(0, snapshot.lastEventIndex - statistics.lastSelectedEventIndex) /
              Math.max(1, snapshot.lastEventIndex + 1),
          );
        const total =
          policy.weights.productivity * productivity +
          policy.weights.exploration * exploration +
          policy.weights.novelty * novelty +
          policy.weights.coverage * coverage +
          policy.weights.recency * recency;
        return { nodeId: node.id, productivity, exploration, novelty, coverage, recency, total };
      })
      .sort((left, right) => right.total - left.total || left.nodeId.localeCompare(right.nodeId));
  }

  private rankPairs(
    snapshot: FrontierSnapshot,
    scoreById: ReadonlyMap<string, FrontierSelectionScore>,
    assignments: readonly FrontierAssignmentRecordedEvent[],
    previous: Assignment | undefined,
    policy: ResolvedFrontierPolicy,
  ): Array<{ primary: string; donor: string; total: number }> {
    const pairCounts = new Map<string, number>();
    const participationCounts = new Map<string, number>();
    for (const event of assignments) {
      const parents = assignmentParentIds(event.assignment);
      for (const parentId of parents) participationCounts.set(parentId, (participationCounts.get(parentId) ?? 0) + 1);
      if (parents.length !== 2) continue;
      const key = [...parents].sort().join("\u0000");
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
    const previousParticipants = new Set(previous ? assignmentParentIds(previous) : []);
    const pairs: Array<{ primary: string; donor: string; total: number }> = [];
    for (const primarySlot of snapshot.frontier) {
      for (const donorSlot of snapshot.frontier) {
        if (primarySlot.nodeId === donorSlot.nodeId) continue;
        const primary = snapshot.nodes[primarySlot.nodeId]!;
        const donor = snapshot.nodes[donorSlot.nodeId]!;
        const key = [primary.id, donor.id].sort().join("\u0000");
        const participationPenalty =
          ((participationCounts.get(primary.id) ?? 0) + (participationCounts.get(donor.id) ?? 0)) * policy.weights.recency;
        const recentRolePenalty =
          (Number(previousParticipants.has(primary.id)) + Number(previousParticipants.has(donor.id))) * policy.weights.recency;
        const total =
          scoreById.get(primary.id)!.total +
          scoreById.get(donor.id)!.total * 0.5 +
          fileNovelty(primary, donor) * policy.weights.novelty -
          (pairCounts.get(key) ?? 0) * policy.weights.pairRepetitionPenalty -
          participationPenalty -
          recentRolePenalty;
        pairs.push({ primary: primary.id, donor: donor.id, total });
      }
    }
    return pairs.sort((left, right) =>
      right.total - left.total ||
      left.primary.localeCompare(right.primary) ||
      left.donor.localeCompare(right.donor),
    );
  }

  private freshBest(history: readonly FrontierEvent[], currentBestId: string): string | undefined {
    let previousBest: string | undefined;
    let promotedAt = -1;
    for (const event of history) {
      if (event.type !== "evaluation-recorded") continue;
      const best = event.frontier[0]?.nodeId;
      if (previousBest !== undefined && best === currentBestId && best !== previousBest) promotedAt = event.index;
      previousBest = best;
    }
    if (promotedAt < 0) return undefined;
    const alreadyCrossed = history.some(
      (event) =>
        event.index > promotedAt &&
        event.type === "assignment-recorded" &&
        event.assignment.operator === "crossover" &&
        assignmentParentIds(event.assignment).includes(currentBestId),
    );
    return alreadyCrossed ? undefined : currentBestId;
  }

  private recalculateRoles(
    candidates: readonly NodeRecord[],
    evaluations: Readonly<Record<string, Evaluation>>,
    policy: ResolvedFrontierPolicy,
  ): FrontierSlot[] {
    if (candidates.length === 0) return [];
    const scored = candidates
      .map((node, order) => ({
        node,
        order,
        primary: metricMedian(evaluations[node.id], this.config.primaryMetric),
      }))
      .filter((entry): entry is { node: NodeRecord; order: number; primary: number } => entry.primary !== undefined);
    scored.sort((left, right) =>
      compareMetric(left.primary, right.primary, this.config.primaryDirection) ||
      left.order - right.order ||
      left.node.id.localeCompare(right.node.id),
    );
    const best = scored[0];
    if (!best) return [];

    const selected: NodeRecord[] = [best.node];
    const nodeIds = [best.node.id];
    const roles: FrontierRole[] = ["BEST"];
    const lean = scored
      .filter(({ node, primary }) =>
        node.id !== best.node.id &&
        withinTolerance(primary, best.primary, this.config.primaryDirection, policy.frontier.leanPrimaryTolerance),
      )
      .map((entry) => ({ ...entry, cost: this.cost(entry.node, evaluations[entry.node.id]) }))
      .filter((entry) => entry.cost !== undefined && this.improvesCost(entry.cost, this.cost(best.node, evaluations[best.node.id])))
      .sort((left, right) =>
        this.compareCost(left.cost!, right.cost!) ||
        compareMetric(left.primary, right.primary, this.config.primaryDirection) ||
        left.order - right.order ||
        left.node.id.localeCompare(right.node.id),
      )[0];
    if (lean) {
      selected.push(lean.node);
      nodeIds.push(lean.node.id);
      roles.push("LEAN");
    }

    while (nodeIds.length < policy.frontier.size) {
      const diverse = scored
        .filter(({ node, primary }) =>
          !nodeIds.includes(node.id) &&
          withinTolerance(primary, best.primary, this.config.primaryDirection, policy.frontier.diversePrimaryTolerance),
        )
        .map((entry) => ({ ...entry, novelty: minimumNovelty(entry.node, selected) }))
        .filter((entry) => entry.novelty >= policy.frontier.diverseNoveltyThreshold)
        .sort((left, right) =>
          right.novelty - left.novelty ||
          compareMetric(left.primary, right.primary, this.config.primaryDirection) ||
          left.order - right.order ||
          left.node.id.localeCompare(right.node.id),
        )[0];
      if (!diverse) break;
      selected.push(diverse.node);
      nodeIds.push(diverse.node.id);
      roles.push("DIVERSE");
    }
    return slotsFor(nodeIds, roles);
  }

  private cost(node: NodeRecord, evaluation: Evaluation | undefined): number | undefined {
    return this.config.costMetric
      ? metricMedian(evaluation, this.config.costMetric)
      : node.diffSummary.changedLines;
  }

  private compareCost(left: number, right: number): number {
    return compareMetric(left, right, this.config.costDirection ?? "lower");
  }

  private improvesCost(candidate: number, incumbent: number | undefined): boolean {
    return incumbent !== undefined && isStrictlyBetter(candidate, incumbent, this.config.costDirection ?? "lower");
  }

  private assertDerivedFrontier(
    frontier: readonly FrontierSlot[],
    nodes: Readonly<Record<string, NodeRecord>>,
    evaluations: Readonly<Record<string, Evaluation>>,
    policy: ResolvedFrontierPolicy | undefined,
  ): void {
    if (frontier.length > 4) throw new Error("frontier cannot contain more than four nodes");
    if (new Set(frontier.map((slot) => slot.nodeId)).size !== frontier.length) {
      throw new Error("a node cannot occupy multiple frontier slots");
    }
    const candidates = frontier.map((slot, index) => {
      if (slot.index !== index) throw new Error("frontier slot indexes must be contiguous");
      const node = nodes[slot.nodeId];
      if (
        !node ||
        node.outcome !== "promoted" ||
        !hasEligibleEvaluation(evaluations[node.id], node.id, this.config.primaryMetric)
      ) {
        throw new Error(`frontier node ${slot.nodeId} is not a confirmed promoted node`);
      }
      return node;
    });
    if (!policy) {
      if (frontier.length !== 0) throw new Error("frontier roles have no policy version");
      return;
    }
    // Recheck persisted slots and roles under the exact immutable policy that
    // derived the latest frontier transition. A newer pending assignment must not
    // rewrite old roles, but it also must never disable equality verification.
    if (!isDeepStrictEqual(frontier, this.recalculateRoles(candidates, evaluations, policy))) {
      throw new Error("frontier roles do not match the policy active at the transition");
    }
  }
}
