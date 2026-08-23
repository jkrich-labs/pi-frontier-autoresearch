import type { CandidateDiff, GitWorkspacePort, WorkerAdapter, WorkerOutcome } from "./adapters.ts";
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
}

export interface CandidateResult {
  node: NodeRecord;
  submission?: CandidateSubmission;
  worker: WorkerOutcome;
  reason?: string;
}

export class CandidateCreator {
  readonly #workspace: GitWorkspacePort;
  readonly #worker: WorkerAdapter;

  constructor(workspace: GitWorkspacePort, worker: WorkerAdapter) {
    this.#workspace = workspace;
    this.#worker = worker;
  }

  async create(request: CreateCandidateRequest): Promise<CandidateResult> {
    const { spec, assignment, parent, donor, signal } = request;
    if (assignment.operator === "crossover" && (!donor || donor.id !== assignment.donorParentId)) {
      throw new Error("A crossover assignment requires its assigned donor node");
    }
    let worktree = await this.#workspace.materialise(assignment, parent, donor);
    try {
      let worker: WorkerOutcome;
      try {
        worker = await this.#worker.run(spec, assignment, worktree, signal);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        worker = {
          status: signal?.aborted ? "cancelled" : "failed",
          stdout: "",
          stderr: reason,
          reason,
        };
      }
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
