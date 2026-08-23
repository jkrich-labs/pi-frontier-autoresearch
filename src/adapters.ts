import type {
  Assignment,
  CandidateSubmission,
  Evaluation,
  NodeRecord,
  PolicyReviewAssignment,
  PolicyReviewTrigger,
  PromotionGate,
  RunEvent,
  RunSpec,
  RunState,
} from "./contracts.ts";

export interface Clock {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

/** Durable identity for a POSIX worker group. The leader identity prevents PID/PGID reuse from targeting an unrelated group. */
export interface ProcessGroupIdentity {
  processGroupId: number;
  leaderPid: number;
  leaderStartIdentity: string;
}

export interface ProcessRequest {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** Keep at most this many bytes from each captured stream. */
  maxOutputBytes?: number;
  input?: string;
  /** Called with the durable POSIX group identity immediately after spawn. */
  onProcessGroup?: (identity: ProcessGroupIdentity) => void | Promise<void>;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  /** One or both captured process streams exceeded ProcessRequest.maxOutputBytes. */
  outputTruncated?: boolean;
  reportedCostUsd?: number;
}

export interface ProcessExecutor {
  run(request: ProcessRequest, signal?: AbortSignal): Promise<ProcessResult>;
  /** Check a durable leader identity before crash-recovery termination. */
  isProcessGroupIdentityCurrent(identity: ProcessGroupIdentity): Promise<boolean>;
  /**
   * Actively terminate a group this live controller observed at spawn and still
   * owns. If its leader exited while descendants remain, the extant group is safe
   * to signal: POSIX cannot reuse its PGID until that group is gone.
   */
  terminateOwnedProcessGroupAndWait(identity: ProcessGroupIdentity, timeoutMs: number): Promise<boolean>;
  /**
   * Actively terminate a group recovered from durable state only after its leader
   * identity is currently verified. Missing or mismatched leaders fail closed and
   * are never used to signal a possibly reused PGID.
   */
  terminateRecoveredProcessGroupAndWait(identity: ProcessGroupIdentity, timeoutMs: number): Promise<boolean>;
  /**
   * Observe (without signalling) an already-owned group until it is gone. A false
   * result is deliberately conservative: a surviving or reused PGID is never safe
   * to clear from durable ownership state.
   */
  waitForProcessGroupExit(identity: ProcessGroupIdentity, timeoutMs: number): Promise<boolean>;
}

export interface WorkerMarker {
  experimentId: string;
  /** Candidate remains the backward-compatible default; policy reviews have no worktree. */
  kind?: "candidate" | "policy-review";
  reviewId?: string;
  process?: ProcessGroupIdentity;
  /** A prior controller durably observed this group gone, so recovery need not signal it. */
  processExited?: true;
  /** Worker-return data is persisted before candidate verification can crash. */
  reportedCostUsd?: number;
  status?: WorkerOutcome["status"];
  reason?: string;
}

export interface StoreInitialisationClaim {
  /** Opaque capability tied to one durable filesystem claim. */
  readonly token: string;
}

export interface StoreAdapter {
  /**
   * Atomically reserve a truly empty durable store before baseline calibration.
   * Production implementations must exclude other processes, not merely other
   * calls in this process. An abandoned claim remains a durable artifact.
   */
  claimInitialisation(spec: RunSpec): Promise<StoreInitialisationClaim>;
  /**
   * Commit initial state under, and consume, the exact claim returned above.
   * The claim is released only after the initial state is durable; failures leave
   * an artifact that blocks configuration until an explicit clear.
   */
  initialise(spec: RunSpec, state: RunState, claim: StoreInitialisationClaim): Promise<void>;
  writeGeneratedSpec(content: string): Promise<void>;
  append(event: RunEvent): Promise<void>;
  snapshot(state: RunState): Promise<void>;
  load(): Promise<{ events: readonly RunEvent[]; snapshot?: RunState }>;
  /**
   * Return false only when no store-owned durable object exists. Partial state,
   * initialisation claims, temporary files, and worker markers are artifacts.
   * Implementations must reject when emptiness cannot be established.
   */
  hasRunArtifacts(): Promise<boolean>;
  clear(): Promise<void>;
  /** Durable ownership markers are mandatory and unreadable markers must reject. */
  writeWorkerMarker(marker: WorkerMarker): Promise<void>;
  readWorkerMarker(): Promise<WorkerMarker | undefined>;
  clearWorkerMarker(): Promise<void>;
}

export interface WorktreeHandle {
  path: string;
  parentCommit: string;
  experimentId: string;
  donorCommit?: string;
  gitMetadata?: string;
  gitDirectory?: string;
  gitCommonDirectory?: string;
  gitCommonDirectoryRealPath?: string;
  gitMetadataDigest?: string;
}

export interface GitMetadataIntegrity {
  intact: boolean;
  detail?: string;
}

export interface CandidateDiff {
  files: readonly string[];
  changedLines: number;
  empty: boolean;
}

export interface GitWorkspacePort {
  inspectRepository(path: string): Promise<{ root: string; head: string; clean: boolean }>;
  materialise(assignment: Assignment, parent: NodeRecord, donor?: NodeRecord): Promise<WorktreeHandle>;
  verifyGitMetadata(worktree: WorktreeHandle): Promise<GitMetadataIntegrity>;
  rematerialiseAfterMetadataFailure(
    worktree: WorktreeHandle,
    assignment: Assignment,
    parent: NodeRecord,
    donor?: NodeRecord,
  ): Promise<WorktreeHandle>;
  inspectDiff(worktree: WorktreeHandle): Promise<CandidateDiff>;
  discardChanges(worktree: WorktreeHandle): Promise<void>;
  commitCandidate(worktree: WorktreeHandle, message: string): Promise<{ commit: string; ref: string }>;
  persistNode(node: NodeRecord): Promise<string>;
  readNodeRecord(nodeId: string): Promise<NodeRecord>;
  remove(worktree: WorktreeHandle): Promise<void>;
  recover(): Promise<void>;
  /** Delete immutable Git refs strictly within this workspace's run namespace. */
  clearRunRefs?(): Promise<void>;
}

export interface WorkerOutcome {
  status: "submitted" | "failed" | "timed-out" | "cancelled";
  submission?: CandidateSubmission;
  stdout: string;
  stderr: string;
  reportedCostUsd?: number;
  process?: ProcessGroupIdentity;
  reason?: string;
}

export interface WorkerAdapter {
  run(
    spec: RunSpec,
    assignment: Assignment,
    worktree: WorktreeHandle,
    signal?: AbortSignal,
    onProcessGroup?: (identity: ProcessGroupIdentity) => void | Promise<void>,
  ): Promise<WorkerOutcome>;
}

/** Read-only, fresh-process context supplied to the constrained policy reviewer. */
export interface PolicyReviewContext {
  spec: RunSpec;
  review: PolicyReviewAssignment;
  trigger: PolicyReviewTrigger;
  activePolicy: import("./contracts.ts").FrontierPolicyVersion;
  recentOutcomes: readonly import("./contracts.ts").NodeOutcome[];
}

export interface PolicyReviewOutcome {
  status: "proposed" | "failed" | "timed-out" | "cancelled";
  proposal?: unknown;
  stdout: string;
  stderr: string;
  process?: ProcessGroupIdentity;
  reason?: string;
}

export interface PolicyReviewerAdapter {
  review(
    context: PolicyReviewContext,
    signal?: AbortSignal,
    onProcessGroup?: (identity: ProcessGroupIdentity) => void | Promise<void>,
  ): Promise<PolicyReviewOutcome>;
}

export interface EvaluatorAdapter {
  calibrate(spec: RunSpec, signal?: AbortSignal): Promise<Evaluation>;
  evaluate(
    spec: RunSpec,
    candidate: NodeRecord,
    parent: NodeRecord,
    promotionGate: PromotionGate,
    signal?: AbortSignal,
  ): Promise<Evaluation>;
}
