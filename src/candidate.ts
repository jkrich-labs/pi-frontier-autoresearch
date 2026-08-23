import type { CandidateDiff, GitWorkspacePort, ProcessGroupIdentity, WorkerAdapter, WorkerOutcome } from "./adapters.ts";
import type {
  Assignment,
  CandidateSubmission,
  NodeOutcome,
  NodeRecord,
  RunSpec,
} from "./contracts.ts";
import { WorkerConfinement } from "./worker-confinement.ts";
import { LOCAL_RUN_STATE_PATHS, candidateSubmissionError } from "./worker-contract.ts";

export interface CreateCandidateRequest {
  spec: RunSpec;
  assignment: Assignment;
  parent: NodeRecord;
  donor?: NodeRecord;
  signal?: AbortSignal;
  onProcessGroup?: (identity: ProcessGroupIdentity) => void | Promise<void>;
  /** Persists worker-return accounting before metadata verification or node persistence. */
  onWorkerResult?: (worker: WorkerOutcome) => void | Promise<void>;
  /** Runs after the worker has returned and before any controller worktree access. */
  onProcessGroupExit?: (identity: ProcessGroupIdentity) => void | Promise<void>;
}

export interface CandidateResult {
  node: NodeRecord;
  submission?: CandidateSubmission;
  worker: WorkerOutcome;
  reason?: string;
}

/** The coordinator stopped after assignment persistence but before a worker was spawned. */
export class WorkerLaunchPreventedError extends Error {
  constructor() {
    super("Worker launch was prevented before spawn");
    this.name = "WorkerLaunchPreventedError";
  }
}

export class CandidateCreator {
  readonly #workspace: GitWorkspacePort;
  readonly #worker: WorkerAdapter;

  constructor(workspace: GitWorkspacePort, worker: WorkerAdapter) {
    this.#workspace = workspace;
    this.#worker = worker;
  }

  async create(request: CreateCandidateRequest): Promise<CandidateResult> {
    const { spec, assignment, parent, donor, signal, onProcessGroup, onWorkerResult, onProcessGroupExit } = request;
    if (assignment.operator === "crossover" && (!donor || donor.id !== assignment.donorParentId)) {
      throw new Error("A crossover assignment requires its assigned donor node");
    }
    if (signal?.aborted) throw new WorkerLaunchPreventedError();
    let worktree = await this.#workspace.materialise(assignment, parent, donor);
    try {
      if (signal?.aborted) throw new WorkerLaunchPreventedError();
      let worker: WorkerOutcome;
      let process: ProcessGroupIdentity | undefined;
      try {
        worker = await this.#worker.run(spec, assignment, worktree, signal, async (identity) => {
          process = identity;
          await onProcessGroup?.(identity);
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        worker = {
          status: signal?.aborted ? "cancelled" : "failed",
          stdout: "",
          stderr: reason,
          reason,
        };
      }
      // The group must be confirmed gone before this controller touches the worktree
      // again. This creates a durable-safe gap between worker exit and node persistence.
      if (worker.process && (!process || worker.process.processGroupId !== process.processGroupId ||
        worker.process.leaderPid !== process.leaderPid || worker.process.leaderStartIdentity !== process.leaderStartIdentity)) {
        throw new Error("Worker returned a process identity that was not durably reported at spawn");
      }
      // The result includes billed cost and the worker's own terminal reason. Keep it
      // durable before waiting for descendants, checking metadata, or persisting Git.
      await onWorkerResult?.(worker);
      if (process) await onProcessGroupExit?.(process);
      // This must be the first controller interaction with the worktree after the
      // worker. In particular, do not let Git status/diff refresh a corrupted index.
      const metadataIntegrity = await this.#workspace.verifyGitMetadata(worktree);
      let diff: CandidateDiff;
      let outcome: NodeOutcome = "pending";
      let reason: string | undefined;
      if (!metadataIntegrity.intact) {
        outcome = "failed";
        reason = `Git metadata integrity check failed: ${metadataIntegrity.detail ?? "metadata changed"}`;
        diff = { files: [".git"], changedLines: 0, empty: false };
        worktree = await this.#workspace.rematerialiseAfterMetadataFailure(
          worktree,
          assignment,
          parent,
          donor,
        );
      } else {
        diff = await this.#workspace.inspectDiff(worktree);
        const invalidPaths = await this.#invalidChangedPaths(spec, worktree.path, diff.files);
        const submissionIssue = candidateSubmissionError(worker.submission, assignment.operator);
        if (invalidPaths.length > 0) {
          outcome = "failed";
          reason = `Candidate diff violates confinement: ${invalidPaths.join("; ")}`;
          await this.#workspace.discardChanges(worktree);
        } else if (worker.status !== "submitted") {
          outcome = "failed";
          reason = worker.reason ?? `Worker ${worker.status}`;
        } else if (submissionIssue) {
          outcome = "failed";
          reason = worker.submission ? submissionIssue : "Worker exited without a structured candidate submission";
        } else if (diff.empty) {
          outcome = "failed";
          reason = "Candidate has an empty diff";
        }
      }

      const commitMessage = [
        `frontier candidate ${assignment.experimentId}`,
        "",
        `Outcome: ${outcome}`,
        ...(reason ? [`Reason: ${reason}`] : []),
      ].join("\n");
      const committed = await this.#workspace.commitCandidate(worktree, commitMessage);
      const submission = worker.submission;
      const node: NodeRecord = {
        id: assignment.experimentId,
        commit: committed.commit,
        ref: committed.ref,
        parentIds: [parent.id, ...(donor ? [donor.id] : [])],
        operator: assignment.operator,
        hypothesis: submission?.hypothesis ?? assignment.hypothesis,
        reflection: submission?.reflection ?? reason ?? "Worker did not provide a reflection",
        diffSummary: { changedFiles: diff.files, changedLines: diff.changedLines },
        metricSamples: {},
        guardResults: [],
        outcome,
        ...(worker.reportedCostUsd === undefined ? {} : { reportedCostUsd: worker.reportedCostUsd }),
        policyVersion: assignment.policyVersion,
        createdEventIndex: 0,
        selection: { attempts: 0, promotions: 0 },
      };
      await this.#workspace.persistNode(node);
      return { node, submission, worker, reason };
    } finally {
      await this.#workspace.remove(worktree);
    }
  }

  /**
   * Close a persisted assignment that lost its worker before a candidate node was saved.
   * The empty commit is Git-backed evidence of the interruption, not a retry.
   */
  async interrupt(request: Omit<CreateCandidateRequest, "signal" | "onProcessGroup" | "onWorkerResult" | "onProcessGroupExit">, reason: string): Promise<NodeRecord> {
    const { assignment, parent, donor } = request;
    let worktree = await this.#workspace.materialise(assignment, parent, donor);
    try {
      await this.#workspace.discardChanges(worktree);
      const committed = await this.#workspace.commitCandidate(
        worktree,
        `frontier candidate ${assignment.experimentId}\n\nOutcome: interrupted\nReason: ${reason}`,
      );
      const node: NodeRecord = {
        id: assignment.experimentId,
        commit: committed.commit,
        ref: committed.ref,
        parentIds: [parent.id, ...(donor ? [donor.id] : [])],
        operator: assignment.operator,
        hypothesis: assignment.hypothesis,
        reflection: reason,
        diffSummary: { changedFiles: [], changedLines: 0 },
        metricSamples: {},
        guardResults: [],
        outcome: "interrupted",
        policyVersion: assignment.policyVersion,
        createdEventIndex: 0,
        selection: { attempts: 0, promotions: 0 },
      };
      await this.#workspace.persistNode(node);
      return node;
    } finally {
      await this.#workspace.remove(worktree);
    }
  }

  async #invalidChangedPaths(
    spec: RunSpec,
    worktree: string,
    files: readonly string[],
  ): Promise<string[]> {
    const confinement = new WorkerConfinement({
      worktree,
      editableGlobs: spec.editableGlobs,
      protectedPaths: spec.protectedPaths,
      runStatePaths: LOCAL_RUN_STATE_PATHS,
    });
    const invalid: string[] = [];
    for (const file of files) {
      try {
        await confinement.mutablePath(file);
      } catch (error) {
        invalid.push(`${file} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return invalid;
  }
}
