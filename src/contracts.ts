export type MetricDirection = "higher" | "lower";
export type RunStatus =
  | "configured"
  | "running"
  | "pausing"
  | "paused"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";
export type FrontierRole = "BEST" | "LEAN" | "DIVERSE";
export type ExperimentOperator = "mutation" | "crossover";
export type GuardStatus = "passed" | "failed";
export type NodeOutcome = "pending" | "promoted" | "rejected" | "failed" | "interrupted";

export interface CommandSpec {
  command: string;
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
}

export interface MetricSpec {
  name: string;
  direction: MetricDirection;
  guard?: { minimum?: number; maximum?: number };
}

export interface ProbeSpec extends CommandSpec {
  name: string;
  description: string;
}

export interface CommandGuard {
  type: "command";
  name: string;
  command: CommandSpec;
}

export interface ChangedLinesGuard {
  type: "changed-lines";
  maximum: number;
}

export interface MetricGuard {
  type: "metric";
  metric: string;
  minimum?: number;
  maximum?: number;
}

export type GuardSpec = CommandGuard | ChangedLinesGuard | MetricGuard;

export interface Budget {
  maxExperiments?: number;
  maxWallTimeMs?: number;
  maxReportedCostUsd?: number;
  unlimited?: true;
}

export interface BaselineConfig {
  samples: number;
}

export interface ConfirmationConfig {
  maxSamples: number;
  confidenceMultiplier: number;
}

export interface FrontierPolicy {
  size: 4;
  leanPrimaryTolerance: number;
  diversePrimaryTolerance: number;
  diverseNoveltyThreshold: number;
  crossoverCadence: number;
}

/** The only search-selection weights that an opt-in policy review may tune. */
export interface FrontierSelectionWeights {
  productivity: number;
  exploration: number;
  novelty: number;
  coverage: number;
  recency: number;
  pairRepetitionPenalty: number;
}

/** Immutable, replayable search-policy snapshot. Evaluation and safety contracts are deliberately absent. */
export interface FrontierPolicyVersion {
  version: number;
  frontier: FrontierPolicy;
  weights: FrontierSelectionWeights;
}

export type PolicyReviewTrigger = "stall-no-promotions" | "degeneration-terminal-outcomes";

export interface PolicyReviewAssignment {
  reviewId: string;
  trigger: PolicyReviewTrigger;
  policyVersion: number;
}

export interface RunSpec {
  schemaVersion: 1;
  runId: string;
  targetRepository: string;
  objective: string;
  primaryMetric: string;
  metrics: readonly MetricSpec[];
  evaluator: CommandSpec;
  editableGlobs: readonly string[];
  protectedPaths: readonly string[];
  probes: readonly ProbeSpec[];
  guards: readonly GuardSpec[];
  budget: Budget;
  baseline: BaselineConfig;
  confirmation: ConfirmationConfig;
  frontierPolicy: FrontierPolicy;
  policyTuning?: { enabled: boolean };
}

export interface MetricSummary {
  median: number;
  medianAbsoluteDeviation: number;
  minimum: number;
  maximum: number;
}

export interface BaselineRecord {
  samples: Readonly<Record<string, readonly number[]>>;
  summaries: Readonly<Record<string, MetricSummary>>;
  calibratedAt: string;
}

export interface GuardResult {
  name: string;
  status: GuardStatus;
  detail?: string;
}

export interface EvaluationLog {
  label: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  fullLogPath: string;
}

export interface ConfirmationEvidence {
  parentNodeId: string;
  promotionRole: FrontierRole;
  pairedSamples: readonly {
    parent: Readonly<Record<string, number>>;
    candidate: Readonly<Record<string, number>>;
  }[];
  outcome: "confirmed" | "rejected" | "exhausted" | "failed";
}

export interface EvaluationEvidence {
  logs: readonly EvaluationLog[];
  confirmation?: ConfirmationEvidence;
}

export interface Evaluation {
  nodeId: string;
  samples: Readonly<Record<string, readonly number[]>>;
  summaries: Readonly<Record<string, MetricSummary>>;
  guards: readonly GuardResult[];
  protectedPathsIntact: boolean;
  scopeValid: boolean;
  confirmationAttempted: boolean;
  confirmed: boolean;
  reason: string;
  evidence?: EvaluationEvidence;
}

export interface PromotionGateInput {
  candidate: NodeRecord;
  initialEvaluation: Evaluation;
}

/** The frontier owns this role decision; the evaluator only schedules confirmation. */
export type PromotionGate = (input: PromotionGateInput) => FrontierRole | undefined;

export interface CandidateSubmission {
  hypothesis: string;
  change: string;
  expectedEffect: string;
  reflection: string;
  donorIdea?: string;
}

export interface Assignment {
  experimentId: string;
  operator: ExperimentOperator;
  primaryParentId: string;
  donorParentId?: string;
  hypothesis: string;
  policyVersion: number;
}

export interface NodeRecord {
  id: string;
  commit: string;
  ref: string;
  parentIds: readonly string[];
  operator: ExperimentOperator | "baseline";
  hypothesis: string;
  reflection: string;
  diffSummary: { changedFiles: readonly string[]; changedLines: number };
  metricSamples: Readonly<Record<string, readonly number[]>>;
  guardResults: readonly GuardResult[];
  outcome: NodeOutcome;
  /** Captured in the Git-backed node before the worker-finished event is appended. */
  reportedCostUsd?: number;
  policyVersion: number;
  createdEventIndex: number;
  selection: {
    attempts: number;
    promotions: number;
    lastSelectedEventIndex?: number;
  };
}

export interface FrontierSlot {
  index: 0 | 1 | 2 | 3;
  role: FrontierRole;
  nodeId: string;
}

export interface BudgetUsage {
  experiments: number;
  wallTimeMs: number;
  reportedCostUsd: number;
}

export interface RunState {
  spec: RunSpec;
  status: RunStatus;
  baseline?: BaselineRecord;
  nodes: Readonly<Record<string, NodeRecord>>;
  frontier: readonly FrontierSlot[];
  activeAssignment?: Assignment;
  budgetUsage: BudgetUsage;
  /** Kept alongside activePolicy for compact status consumers. */
  policyVersion: number;
  activePolicy: FrontierPolicyVersion;
  /** Append-only policy snapshots; rollback adds a new version rather than rewriting this history. */
  policyHistory: readonly FrontierPolicyVersion[];
  activePolicyReview?: PolicyReviewAssignment;
  lastEventIndex: number;
  latestDecision?: string;
}

export type RunEventType =
  | "run-configured"
  | "frontier-policy-recorded"
  | "policy-review-recorded"
  | "policy-review-finished"
  | "run-started"
  | "pause-requested"
  | "run-paused"
  | "stop-requested"
  | "run-stopped"
  | "assignment-recorded"
  | "worker-finished"
  | "node-recorded"
  | "evaluation-recorded"
  | "frontier-updated"
  | "experiment-finished"
  | "policy-proposed"
  | "policy-updated"
  | "policy-rolled-back"
  | "run-completed"
  | "run-failed";

export interface RunEventDataMap {
  "run-configured": { specDigest: string; spec: RunSpec; baseline: BaselineRecord };
  "frontier-policy-recorded": { policy: FrontierPolicyVersion };
  "policy-review-recorded": { review: PolicyReviewAssignment };
  "policy-review-finished": { reviewId: string; status: "proposed" | "failed" | "timed-out" | "cancelled"; reason?: string };
  "run-started": Record<string, never>;
  "pause-requested": Record<string, never>;
  "run-paused": Record<string, never>;
  "stop-requested": { reason: string };
  "run-stopped": { reason: string };
  "assignment-recorded": { assignment: Assignment };
  "worker-finished": { status: NodeOutcome; reportedCostUsd?: number; reason?: string };
  "node-recorded": { node: NodeRecord };
  "evaluation-recorded": { evaluation: Evaluation };
  "frontier-updated": { slots: readonly FrontierSlot[]; reason: string };
  "experiment-finished": { nodeId: string; outcome: NodeOutcome };
  /** Accepted proposals are normalized; rejected submissions retain only a bounded canonical audit record. */
  "policy-proposed": {
    version: number;
    reviewId: string;
    trigger: PolicyReviewTrigger;
    proposal: unknown;
    accepted: boolean;
    reason: string;
  };
  "policy-updated": { version: number; previousVersion: number; policy: FrontierPolicyVersion };
  "policy-rolled-back": {
    version: number;
    previousVersion: number;
    restoredVersion: number;
    policy: FrontierPolicyVersion;
  };
  "run-completed": { reason: string };
  "run-failed": { reason: string };
}

export type RunEvent<T extends RunEventType = RunEventType> = {
  [K in T]: {
    index: number;
    type: K;
    at: string;
    runId: string;
    experimentId?: string;
    data: RunEventDataMap[K];
  };
}[T];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function validateCommand(value: unknown, label: string, issues: string[]): value is CommandSpec {
  if (!isRecord(value) || !isNonEmptyString(value.command)) {
    issues.push(`${label} command must be non-empty`);
    return false;
  }
  if (!isPositiveFinite(value.timeoutMs)) issues.push(`${label} timeoutMs must be positive`);
  if (
    value.env !== undefined &&
    (!isRecord(value.env) || Object.values(value.env).some((entry) => typeof entry !== "string"))
  ) {
    issues.push(`${label} env must contain only string values`);
  }
  return true;
}

function validateStringArray(
  value: unknown,
  label: string,
  issues: string[],
  options: { allowEmpty: boolean },
): value is string[] {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`);
    return false;
  }
  if (!options.allowEmpty && value.length === 0) {
    issues.push(`${label} must contain at least one path pattern`);
  }
  if (value.some((entry) => !isNonEmptyString(entry))) {
    issues.push(`${label} must contain only non-empty strings`);
  }
  return true;
}

export function validateRunSpec(value: unknown): string[] {
  if (!isRecord(value)) return ["run spec must be an object"];

  const issues: string[] = [];
  const budget = value.budget;
  if (!isRecord(budget)) {
    issues.push("budget must be an object");
  } else {
    if (budget.maxExperiments !== undefined && !isPositiveInteger(budget.maxExperiments)) {
      issues.push("budget maxExperiments must be a positive integer");
    }
    for (const key of ["maxWallTimeMs", "maxReportedCostUsd"] as const) {
      if (budget[key] !== undefined && !isPositiveFinite(budget[key])) {
        issues.push(`budget ${key} must be positive`);
      }
    }
    const finiteLimit =
      isPositiveInteger(budget.maxExperiments) ||
      isPositiveFinite(budget.maxWallTimeMs) ||
      isPositiveFinite(budget.maxReportedCostUsd);
    if (!finiteLimit && budget.unlimited !== true) {
      issues.push("budget must set a finite limit or explicitly allow unlimited execution");
    }
    if (budget.unlimited !== undefined && budget.unlimited !== true) {
      issues.push("budget unlimited must be true when set");
    }
  }

  if (value.schemaVersion !== 1) issues.push("schemaVersion must be 1");
  for (const key of ["runId", "targetRepository", "objective", "primaryMetric"] as const) {
    if (!isNonEmptyString(value[key])) issues.push(`${key} must be a non-empty string`);
  }

  const metricNames = new Set<string>();
  if (!Array.isArray(value.metrics) || value.metrics.length === 0) {
    issues.push("metrics must contain at least one metric");
  } else {
    for (const metric of value.metrics) {
      if (!isRecord(metric) || !isNonEmptyString(metric.name)) {
        issues.push("every metric must have a non-empty name");
        continue;
      }
      if (metricNames.has(metric.name)) issues.push(`metric "${metric.name}" is duplicated`);
      metricNames.add(metric.name);
      if (metric.direction !== "higher" && metric.direction !== "lower") {
        issues.push(`metric "${metric.name}" must set direction to higher or lower`);
      }
      if (metric.guard !== undefined) {
        if (!isRecord(metric.guard)) {
          issues.push(`metric "${metric.name}" guard must be an object`);
        } else {
          for (const key of ["minimum", "maximum"] as const) {
            const threshold = metric.guard[key];
            if (threshold !== undefined && (typeof threshold !== "number" || !Number.isFinite(threshold))) {
              issues.push(`metric "${metric.name}" guard ${key} must be finite`);
            }
          }
        }
      }
    }
    if (isNonEmptyString(value.primaryMetric) && !metricNames.has(value.primaryMetric)) {
      issues.push(`primary metric "${value.primaryMetric}" is not declared`);
    }
  }

  validateCommand(value.evaluator, "evaluator", issues);
  validateStringArray(value.editableGlobs, "editableGlobs", issues, { allowEmpty: false });
  validateStringArray(value.protectedPaths, "protectedPaths", issues, { allowEmpty: true });

  if (!Array.isArray(value.probes)) {
    issues.push("probes must be an array");
  } else {
    const probeNames = new Set<string>();
    for (const probe of value.probes) {
      if (!isRecord(probe) || !isNonEmptyString(probe.name)) {
        issues.push("every probe must have a non-empty name");
        continue;
      }
      if (probeNames.has(probe.name)) issues.push(`probe "${probe.name}" is duplicated`);
      probeNames.add(probe.name);
      if (!isNonEmptyString(probe.description)) {
        issues.push(`probe "${probe.name}" must have a non-empty description`);
      }
      validateCommand(probe, `probe "${probe.name}"`, issues);
    }
  }

  if (!Array.isArray(value.guards)) {
    issues.push("guards must be an array");
  } else {
    for (const guard of value.guards) {
      if (!isRecord(guard)) {
        issues.push("every guard must be an object");
      } else if (guard.type === "command") {
        if (!isNonEmptyString(guard.name)) issues.push("command guard must have a non-empty name");
        validateCommand(guard.command, `command guard "${String(guard.name ?? "")}"`, issues);
      } else if (guard.type === "changed-lines") {
        if (!isPositiveInteger(guard.maximum)) {
          issues.push("changed-lines guard maximum must be a positive integer");
        }
      } else if (guard.type === "metric") {
        if (!isNonEmptyString(guard.metric)) {
          issues.push("metric guard must name a metric");
        } else if (!metricNames.has(guard.metric)) {
          issues.push(`metric guard references undeclared metric "${guard.metric}"`);
        }
        if (guard.minimum === undefined && guard.maximum === undefined) {
          issues.push(`metric guard "${String(guard.metric ?? "")}" must set a threshold`);
        }
        for (const key of ["minimum", "maximum"] as const) {
          const threshold = guard[key];
          if (threshold !== undefined && (typeof threshold !== "number" || !Number.isFinite(threshold))) {
            issues.push(`metric guard "${String(guard.metric ?? "")}" ${key} must be finite`);
          }
        }
      } else {
        issues.push(`unknown guard type "${String(guard.type)}"`);
      }
    }
  }

  if (!isRecord(value.baseline) || !isPositiveInteger(value.baseline.samples)) {
    issues.push("baseline samples must be a positive integer");
  }
  if (!isRecord(value.confirmation)) {
    issues.push("confirmation must be an object");
  } else {
    if (!isPositiveInteger(value.confirmation.maxSamples)) {
      issues.push("confirmation maxSamples must be a positive integer");
    }
    if (!isPositiveFinite(value.confirmation.confidenceMultiplier)) {
      issues.push("confirmation confidenceMultiplier must be positive");
    }
  }
  if (!isRecord(value.frontierPolicy)) {
    issues.push("frontier policy must be an object");
  } else {
    if (value.frontierPolicy.size !== 4) issues.push("frontier policy size must be 4");
    for (const key of [
      "leanPrimaryTolerance",
      "diversePrimaryTolerance",
      "diverseNoveltyThreshold",
    ] as const) {
      if (!isRatio(value.frontierPolicy[key])) {
        issues.push(`frontier policy ${key} must be between 0 and 1`);
      }
    }
    if (!isPositiveInteger(value.frontierPolicy.crossoverCadence)) {
      issues.push("frontier policy crossoverCadence must be a positive integer");
    }
  }
  if (
    value.policyTuning !== undefined &&
    (!isRecord(value.policyTuning) || typeof value.policyTuning.enabled !== "boolean")
  ) {
    issues.push("policyTuning enabled must be boolean");
  }

  return issues;
}

export function assertRunSpec(value: unknown): asserts value is RunSpec {
  const issues = validateRunSpec(value);
  if (issues.length > 0) {
    throw new Error(`Run spec is invalid: ${issues.join("; ")}`);
  }
}
