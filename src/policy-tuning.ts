import { Type } from "typebox";

import type { FrontierPolicy, FrontierPolicyVersion, FrontierSelectionWeights } from "./contracts.ts";

/**
 * The complete opt-in tuning surface. These numeric values affect parent selection
 * and promotion-shape only; evaluator, guards, budgets, frontier size, and code
 * are intentionally not representable here.
 */
export const POLICY_TUNABLE_SCHEMA = Object.freeze({
  productivityWeight: { minimum: 0, maximum: 2 },
  explorationWeight: { minimum: 0, maximum: 2 },
  noveltyWeight: { minimum: 0, maximum: 2 },
  coverageWeight: { minimum: 0, maximum: 2 },
  recencyWeight: { minimum: 0, maximum: 2 },
  pairRepetitionPenalty: { minimum: 0, maximum: 2 },
  leanPrimaryTolerance: { minimum: 0, maximum: 0.25 },
  diversePrimaryTolerance: { minimum: 0, maximum: 0.5 },
  diverseNoveltyThreshold: { minimum: 0, maximum: 1 },
  crossoverCadence: { minimum: 1, maximum: 8, integer: true },
} as const);

export type PolicyTunableField = keyof typeof POLICY_TUNABLE_SCHEMA;

export interface PolicyReviewProposal {
  rationale: string;
  changes: Readonly<Partial<Record<PolicyTunableField, number>>>;
}

/** A small, non-sensitive record retained for every rejected worker submission. */
export type PolicyProposalRejectionCode =
  | "proposal-not-object"
  | "proposal-too-large"
  | "unknown-top-level-field"
  | "rationale-not-string"
  | "rationale-too-large"
  | "changes-not-object"
  | "changes-empty"
  | "unknown-change-field"
  | "change-not-finite"
  | "change-out-of-range"
  | "unchanged"
  | "reviewer-output-too-large";

export interface PolicyProposalRejectionAudit {
  kind: "policy-proposal-rejected";
  code: PolicyProposalRejectionCode;
  /** Present only for an allowlisted field; never retain worker-provided field names. */
  field?: PolicyTunableField;
  reason: string;
}

export interface PolicyProposalLimits {
  maxProposalBytes?: number;
  maxRationaleBytes?: number;
}

export const MAX_POLICY_REVIEW_PROPOSAL_BYTES = 4 * 1024;
export const MAX_POLICY_REVIEW_RATIONALE_BYTES = 1 * 1024;

/**
 * Deliberately permissive at the extension boundary: the production guard records
 * malformed calls as bounded audit rejections instead of allowing schema handling
 * to turn them into an unauditable generic tool failure.
 */
export const POLICY_REVIEW_PROPOSAL_PARAMETERS = Type.Unknown();

export interface PolicyProposalAccepted {
  accepted: true;
  proposal: PolicyReviewProposal;
  policy: FrontierPolicyVersion;
}

export interface PolicyProposalRejected {
  accepted: false;
  proposal: PolicyProposalRejectionAudit;
  reason: string;
}

export type PolicyProposalValidation = PolicyProposalAccepted | PolicyProposalRejected;

export const DEFAULT_FRONTIER_SELECTION_WEIGHTS: FrontierSelectionWeights = Object.freeze({
  productivity: 1,
  exploration: 0.7,
  novelty: 0.35,
  coverage: 0.25,
  recency: 0.2,
  pairRepetitionPenalty: 0.8,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function limits(options: PolicyProposalLimits): Required<PolicyProposalLimits> {
  const maxProposalBytes = options.maxProposalBytes ?? MAX_POLICY_REVIEW_PROPOSAL_BYTES;
  const maxRationaleBytes = options.maxRationaleBytes ?? MAX_POLICY_REVIEW_RATIONALE_BYTES;
  if (!Number.isInteger(maxProposalBytes) || maxProposalBytes <= 0) {
    throw new Error("maxProposalBytes must be a positive integer");
  }
  if (!Number.isInteger(maxRationaleBytes) || maxRationaleBytes <= 0) {
    throw new Error("maxRationaleBytes must be a positive integer");
  }
  return { maxProposalBytes, maxRationaleBytes };
}

function proposalExceedsBytes(value: unknown, maximum: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined || Buffer.byteLength(serialized) > maximum;
  } catch {
    // A non-serializable value is not safe to persist and is treated as oversized.
    return true;
  }
}

function rejectionReason(code: PolicyProposalRejectionCode, field?: PolicyTunableField): string {
  switch (code) {
    case "proposal-not-object": return "Policy proposal must be an object.";
    case "proposal-too-large": return "Policy proposal exceeds its bounded limit.";
    case "unknown-top-level-field": return "Policy proposal contains an unknown field.";
    case "rationale-not-string": return "Policy proposal rationale must be a non-empty string.";
    case "rationale-too-large": return "Policy proposal rationale exceeds its bounded limit.";
    case "changes-not-object": return "Policy proposal changes must be an object.";
    case "changes-empty": return "Policy proposal changes must not be empty.";
    case "unknown-change-field": return "Policy proposal changes contain an unknown field.";
    case "change-not-finite": return `Policy proposal ${field!} must be finite.`;
    case "change-out-of-range": {
      const bounds = POLICY_TUNABLE_SCHEMA[field!];
      const integer = "integer" in bounds && bounds.integer === true;
      return `Policy proposal ${field!} must be within ${bounds.minimum}..${bounds.maximum}${integer ? " as an integer" : ""}.`;
    }
    case "unchanged": return "Policy proposal does not change the active policy.";
    case "reviewer-output-too-large": return "Policy reviewer output exceeds its bounded limit.";
  }
}

function rejected(code: PolicyProposalRejectionCode, field?: PolicyTunableField): PolicyProposalRejected {
  const audit: PolicyProposalRejectionAudit = {
    kind: "policy-proposal-rejected",
    code,
    ...(field === undefined ? {} : { field }),
    reason: rejectionReason(code, field),
  };
  return { accepted: false, proposal: audit, reason: audit.reason };
}

/** Reject only canonical, bounded audit records during replay. */
export function isPolicyProposalRejectionAudit(value: unknown): value is PolicyProposalRejectionAudit {
  if (!isRecord(value) || value.kind !== "policy-proposal-rejected" || typeof value.code !== "string" ||
    typeof value.reason !== "string") return false;
  const allowedKeys = new Set(["kind", "code", "field", "reason"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  const codes: readonly PolicyProposalRejectionCode[] = [
    "proposal-not-object", "proposal-too-large", "unknown-top-level-field", "rationale-not-string",
    "rationale-too-large", "changes-not-object", "changes-empty", "unknown-change-field",
    "change-not-finite", "change-out-of-range", "unchanged", "reviewer-output-too-large",
  ];
  if (!codes.includes(value.code as PolicyProposalRejectionCode)) return false;
  const requiresField = value.code === "change-not-finite" || value.code === "change-out-of-range";
  if (requiresField !== (value.field !== undefined)) return false;
  if (value.field !== undefined && (typeof value.field !== "string" || !(value.field in POLICY_TUNABLE_SCHEMA))) return false;
  return value.reason === rejectionReason(value.code as PolicyProposalRejectionCode, value.field as PolicyTunableField | undefined);
}

function immutablePolicy(version: number, frontier: FrontierPolicy, weights: FrontierSelectionWeights): FrontierPolicyVersion {
  return Object.freeze({
    version,
    frontier: Object.freeze({ ...frontier }),
    weights: Object.freeze({ ...weights }),
  });
}

/** Build the immutable version-one policy from the immutable configured run contract. */
export function initialPolicyVersion(frontier: FrontierPolicy): FrontierPolicyVersion {
  return immutablePolicy(1, frontier, DEFAULT_FRONTIER_SELECTION_WEIGHTS);
}

/**
 * Validate one untrusted worker proposal and derive, but never mutate, a fresh
 * policy version. Rejections retain only a canonical code and allowlisted field,
 * never raw worker text, unknown keys, or oversized values.
 */
export function validatePolicyProposal(
  active: FrontierPolicyVersion,
  value: unknown,
  nextVersion = active.version + 1,
  options: PolicyProposalLimits = {},
): PolicyProposalValidation {
  const bounded = limits(options);
  if (isPolicyProposalRejectionAudit(value)) return { accepted: false, proposal: value, reason: value.reason };
  if (!isRecord(value)) return rejected("proposal-not-object");
  // Check rationale separately first so a long rationale is never normalized or
  // retained while measuring the rest of a proposed record.
  if (typeof value.rationale === "string" && Buffer.byteLength(value.rationale) > bounded.maxRationaleBytes) {
    return rejected("rationale-too-large");
  }
  if (proposalExceedsBytes(value, bounded.maxProposalBytes)) return rejected("proposal-too-large");
  for (const key of Object.keys(value)) {
    if (key !== "rationale" && key !== "changes") return rejected("unknown-top-level-field");
  }
  if (typeof value.rationale !== "string" || value.rationale.trim() === "") {
    return rejected("rationale-not-string");
  }
  if (!isRecord(value.changes)) return rejected("changes-not-object");
  const entries = Object.entries(value.changes);
  if (entries.length === 0) return rejected("changes-empty");

  const changes: Partial<Record<PolicyTunableField, number>> = {};
  for (const [key, raw] of entries) {
    if (!(key in POLICY_TUNABLE_SCHEMA)) return rejected("unknown-change-field");
    const field = key as PolicyTunableField;
    const bounds = POLICY_TUNABLE_SCHEMA[field];
    if (!isFiniteNumber(raw)) return rejected("change-not-finite", field);
    const integer = "integer" in bounds && bounds.integer === true;
    if (raw < bounds.minimum || raw > bounds.maximum || (integer && !Number.isInteger(raw))) {
      return rejected("change-out-of-range", field);
    }
    changes[field] = raw;
  }

  const frontier: FrontierPolicy = { ...active.frontier };
  const weights: FrontierSelectionWeights = { ...active.weights };
  for (const [field, number] of Object.entries(changes) as Array<[PolicyTunableField, number]>) {
    switch (field) {
      case "productivityWeight": weights.productivity = number; break;
      case "explorationWeight": weights.exploration = number; break;
      case "noveltyWeight": weights.novelty = number; break;
      case "coverageWeight": weights.coverage = number; break;
      case "recencyWeight": weights.recency = number; break;
      case "pairRepetitionPenalty": weights.pairRepetitionPenalty = number; break;
      case "leanPrimaryTolerance": frontier.leanPrimaryTolerance = number; break;
      case "diversePrimaryTolerance": frontier.diversePrimaryTolerance = number; break;
      case "diverseNoveltyThreshold": frontier.diverseNoveltyThreshold = number; break;
      case "crossoverCadence": frontier.crossoverCadence = number; break;
    }
  }
  if (JSON.stringify(frontier) === JSON.stringify(active.frontier) && JSON.stringify(weights) === JSON.stringify(active.weights)) {
    return rejected("unchanged");
  }
  return {
    accepted: true,
    proposal: { rationale: value.rationale.trim(), changes },
    policy: immutablePolicy(nextVersion, frontier, weights),
  };
}

/** Restore an earlier policy's tunables as a new immutable version; history is never rewritten. */
export function restoredPolicyVersion(source: FrontierPolicyVersion, nextVersion: number): FrontierPolicyVersion {
  return immutablePolicy(nextVersion, source.frontier, source.weights);
}
