import type {
  Assignment,
  CandidateSubmission,
  Evaluation,
  NodeRecord,
  RunEvent,
  RunSpec,
  RunState,
} from "./contracts.ts";

export interface Clock {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface ProcessRequest {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  input?: string;
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
  terminateProcessGroup?(processGroupId: number): Promise<void>;
}

export interface StoreAdapter {
  initialise(spec: RunSpec, state: RunState): Promise<void>;
  writeGeneratedSpec(content: string): Promise<void>;
  append(event: RunEvent): Promise<void>;
  snapshot(state: RunState): Promise<void>;
  load(): Promise<{ events: readonly RunEvent[]; snapshot?: RunState }>;
  clear(): Promise<void>;
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
  reason?: string;
}

export interface WorkerAdapter {
  run(
    spec: RunSpec,
    assignment: Assignment,
    worktree: WorktreeHandle,
    signal?: AbortSignal,
  ): Promise<WorkerOutcome>;
}

export interface EvaluatorAdapter {
  calibrate(spec: RunSpec, signal?: AbortSignal): Promise<Evaluation>;
  evaluate(
    spec: RunSpec,
    candidate: NodeRecord,
    parent: NodeRecord,
    signal?: AbortSignal,
  ): Promise<Evaluation>;
}
