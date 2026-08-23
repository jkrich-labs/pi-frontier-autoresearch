import { Type } from "typebox";

import type { WorktreeHandle } from "./adapters.ts";
import type { Assignment, CandidateSubmission, ProbeSpec, RunSpec } from "./contracts.ts";

export const WORKER_TOOL_ALLOWLIST = [
  "read",
  "write",
  "edit",
  "worker_delete",
  "worker_move",
  "worker_probe",
  "inspect_donor",
  "candidate_submit",
] as const;

export const LOCAL_RUN_STATE_PATHS = [
  ".pi-frontier-autoresearch",
  ".autoresearch",
  ".auto",
] as const;

export interface WorkerGuardConfig {
  experimentId: string;
  worktree: string;
  editableGlobs: readonly string[];
  protectedPaths: readonly string[];
  runStatePaths: readonly string[];
  probes: readonly ProbeSpec[];
  donorCommit?: string;
  operator: Assignment["operator"];
}

export const CANDIDATE_SUBMISSION_PARAMETERS = Type.Object({
  hypothesis: Type.String({ minLength: 1 }),
  change: Type.String({ minLength: 1 }),
  expectedEffect: Type.String({ minLength: 1 }),
  reflection: Type.String({ minLength: 1 }),
  donorIdea: Type.Optional(Type.String({ minLength: 1 })),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function candidateSubmissionError(
  value: unknown,
  operator?: Assignment["operator"],
): string | undefined {
  if (!isRecord(value)) return "Candidate submission must be an object";
  for (const key of ["hypothesis", "change", "expectedEffect", "reflection"] as const) {
    if (!isNonEmptyString(value[key])) return `Candidate submission ${key} must be a non-empty string`;
  }
  if (value.donorIdea !== undefined && !isNonEmptyString(value.donorIdea)) {
    return "Candidate submission donorIdea must be a non-empty string";
  }
  if (operator === "crossover" && !isNonEmptyString(value.donorIdea)) {
    return "Crossover submission did not describe the donor idea";
  }
  return undefined;
}

export function parseCandidateSubmission(
  value: unknown,
  operator?: Assignment["operator"],
): CandidateSubmission | undefined {
  if (candidateSubmissionError(value, operator)) return undefined;
  const candidate = value as Record<string, unknown>;
  return {
    hypothesis: candidate.hypothesis as string,
    change: candidate.change as string,
    expectedEffect: candidate.expectedEffect as string,
    reflection: candidate.reflection as string,
    ...(candidate.donorIdea === undefined ? {} : { donorIdea: candidate.donorIdea as string }),
  };
}

export function createWorkerGuardConfig(
  spec: RunSpec,
  assignment: Assignment,
  worktree: WorktreeHandle,
): WorkerGuardConfig {
  return {
    experimentId: assignment.experimentId,
    worktree: worktree.path,
    editableGlobs: spec.editableGlobs,
    protectedPaths: spec.protectedPaths,
    runStatePaths: LOCAL_RUN_STATE_PATHS,
    probes: spec.probes,
    donorCommit: worktree.donorCommit,
    operator: assignment.operator,
  };
}

export function parseWorkerGuardConfig(value: unknown): WorkerGuardConfig {
  if (!isRecord(value)) throw new Error("Worker guard configuration must be an object");
  for (const key of ["experimentId", "worktree"] as const) {
    if (!isNonEmptyString(value[key])) throw new Error(`Worker guard configuration ${key} is required`);
  }
  for (const key of ["editableGlobs", "protectedPaths", "runStatePaths"] as const) {
    if (!Array.isArray(value[key]) || !value[key].every(isNonEmptyString)) {
      throw new Error(`Worker guard configuration ${key} must contain non-empty strings`);
    }
  }
  if (!Array.isArray(value.probes)) throw new Error("Worker guard configuration probes must be an array");
  if (value.operator !== "mutation" && value.operator !== "crossover") {
    throw new Error("Worker guard configuration operator is invalid");
  }
  if (value.donorCommit !== undefined && !isNonEmptyString(value.donorCommit)) {
    throw new Error("Worker guard configuration donorCommit is invalid");
  }
  return value as unknown as WorkerGuardConfig;
}
