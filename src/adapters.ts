import type {
  Assignment,
  CandidateSubmission,
  Evaluation,
  NodeRecord,
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
  process?: ProcessGroupIdentity;
  /** A prior controller durably observed this group gone, so recovery need not signal it. */
  processExited?: true;
  /** Worker-return data is persisted before candidate verification can crash. */
  reportedCostUsd?: number;
  status?: WorkerOutcome["status"];
  reason?: string;
}

export interface StoreAdapter {
  initialise(spec: RunSpec, state: RunState): Promise<void>;
  writeGeneratedSpec(content: string): Promise<void>;
  append(event: RunEvent): Promise<void>;
  snapshot(state: RunState): Promise<void>;
  load(): Promise<{ events: readonly RunEvent[]; snapshot?: RunState }>;
  clear(): Promise<void>;
  /** Optional durable ownership marker used to recover an interrupted worker. */
  writeWorkerMarker?(marker: WorkerMarker): Promise<void>;
  readWorkerMarker?(): Promise<WorkerMarker | undefined>;
  clearWorkerMarker?(): Promise<void>;
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
