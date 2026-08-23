import { fileURLToPath } from "node:url";

import type { PolicyReviewContext, PolicyReviewOutcome, ProcessExecutor, ProcessGroupIdentity } from "./adapters.ts";
import { boundedOutput, NodeProcessExecutor } from "./process.ts";
import {
  MAX_POLICY_REVIEW_PROPOSAL_BYTES,
  MAX_POLICY_REVIEW_RATIONALE_BYTES,
  validatePolicyProposal,
} from "./policy-tuning.ts";

const DEFAULT_GUARD = fileURLToPath(
  new URL("../extensions/pi-frontier-autoresearch/policy-review-guard.ts", import.meta.url),
);

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Policy review has no durable full-output log, so keep its process capture modest. */
export const MAX_POLICY_REVIEW_OUTPUT_BYTES = 16 * 1024;

export interface PolicyReviewerOptions {
  executable?: string;
  guardExtension?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
  /** Maximum captured bytes from either reviewer process stream. */
  maxOutputBytes?: number;
  maxProposalBytes?: number;
  maxRationaleBytes?: number;
  processExecutor?: ProcessExecutor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function proposalFromOutput(stdout: string): unknown | undefined {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { message?: { toolName?: string; details?: unknown } };
      if (event.message?.toolName !== "policy_review_submit") continue;
      const details = event.message.details;
      // The production guard wraps its canonical result so it can distinguish a
      // rejected tool submission from ordinary Pi diagnostic detail.
      if (isRecord(details) && "policyReviewProposal" in details) return details.policyReviewProposal;
      return details;
    } catch {
      // Pi JSON mode can include a diagnostic line from a fixture or local host.
    }
  }
  return undefined;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

/**
 * Launches a fresh Pi process with exactly one submit-only tool. It receives a
 * compact state summary, not checkout tools, evaluator commands, or a shell.
 */
export class PolicyReviewer {
  readonly #options: Required<Pick<
    PolicyReviewerOptions,
    "executable" | "guardExtension" | "timeoutMs" | "maxOutputBytes" | "maxProposalBytes" | "maxRationaleBytes"
  >> & Omit<PolicyReviewerOptions, "executable" | "guardExtension" | "timeoutMs" | "maxOutputBytes" | "maxProposalBytes" | "maxRationaleBytes">;
  readonly #process: ProcessExecutor;

  constructor(options: PolicyReviewerOptions = {}) {
    const inheritedThinking = options.thinkingLevel ?? this.#inheritedThinkingLevel();
    this.#options = {
      ...options,
      executable: options.executable ?? "pi",
      guardExtension: options.guardExtension ?? DEFAULT_GUARD,
      model: options.model ?? (process.env.PI_MODEL?.trim() || undefined),
      thinkingLevel: inheritedThinking,
      timeoutMs: options.timeoutMs ?? 5 * 60_000,
      maxOutputBytes: positiveInteger(options.maxOutputBytes ?? MAX_POLICY_REVIEW_OUTPUT_BYTES, "maxOutputBytes"),
      maxProposalBytes: positiveInteger(options.maxProposalBytes ?? MAX_POLICY_REVIEW_PROPOSAL_BYTES, "maxProposalBytes"),
      maxRationaleBytes: positiveInteger(options.maxRationaleBytes ?? MAX_POLICY_REVIEW_RATIONALE_BYTES, "maxRationaleBytes"),
    };
    this.#process = options.processExecutor ?? new NodeProcessExecutor();
  }

  async review(
    context: PolicyReviewContext,
    signal?: AbortSignal,
    onProcessGroup?: (identity: ProcessGroupIdentity) => void | Promise<void>,
  ): Promise<PolicyReviewOutcome> {
    const args = [
      "--mode", "json", "-p", "--no-session", "--no-extensions", "--extension", this.#options.guardExtension,
      "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--no-builtin-tools",
      "--tools", "policy_review_submit",
    ];
    if (this.#options.model) args.push("--model", this.#options.model);
    if (this.#options.thinkingLevel) args.push("--thinking", this.#options.thinkingLevel);
    args.push(this.#prompt(context));

    let process: ProcessGroupIdentity | undefined;
    try {
      const result = await this.#process.run({
        command: this.#options.executable,
        args,
        cwd: context.spec.targetRepository,
        timeoutMs: this.#options.timeoutMs,
        maxOutputBytes: this.#options.maxOutputBytes,
        onProcessGroup: async (identity) => {
          process = identity;
          await onProcessGroup?.(identity);
        },
      }, signal);
      const stdout = boundedOutput(result.stdout, this.#options.maxOutputBytes);
      const stderr = boundedOutput(result.stderr, this.#options.maxOutputBytes);
      const outputExceeded = result.outputTruncated === true || stdout.truncated || stderr.truncated;
      if (result.cancelled) return { status: "cancelled", stdout: stdout.text, stderr: stderr.text, process, reason: "Policy review cancelled" };
      if (result.timedOut) return { status: "timed-out", stdout: stdout.text, stderr: stderr.text, process, reason: "Policy review timed out" };
      if (result.exitCode !== 0) {
        return {
          status: "failed",
          stdout: stdout.text,
          stderr: stderr.text,
          process,
          reason: `Policy reviewer exited with status ${String(result.exitCode)}`,
        };
      }
      if (outputExceeded) {
        // Do not parse a possibly incomplete tail or carry process output into the
        // event log; retain only this canonical bounded audit record.
        const proposal = {
          kind: "policy-proposal-rejected" as const,
          code: "reviewer-output-too-large" as const,
          reason: "Policy reviewer output exceeds its bounded limit.",
        };
        return { status: "proposed", proposal, stdout: stdout.text, stderr: stderr.text, process, reason: proposal.reason };
      }
      const proposal = proposalFromOutput(stdout.text);
      if (proposal === undefined) {
        return { status: "failed", stdout: stdout.text, stderr: stderr.text, process, reason: "Policy reviewer exited without a structured proposal" };
      }
      const validation = validatePolicyProposal(context.activePolicy, proposal, context.activePolicy.version + 1, {
        maxProposalBytes: this.#options.maxProposalBytes,
        maxRationaleBytes: this.#options.maxRationaleBytes,
      });
      return {
        status: "proposed",
        proposal: validation.proposal,
        stdout: stdout.text,
        stderr: stderr.text,
        process,
        ...(validation.accepted ? {} : { reason: validation.reason }),
      };
    } catch {
      return {
        status: signal?.aborted ? "cancelled" : "failed",
        stdout: "",
        stderr: "Policy reviewer process failed.",
        ...(process ? { process } : {}),
        reason: "Policy reviewer process failed.",
      };
    }
  }

  #inheritedThinkingLevel(): ThinkingLevel | undefined {
    const value = process.env.PI_REASONING_LEVEL?.trim();
    if (!value) return undefined;
    if ((THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
    throw new Error(`PI_REASONING_LEVEL is not supported: ${value}`);
  }

  #prompt(context: PolicyReviewContext): string {
    const policy = context.activePolicy;
    return [
      "You are a bounded policy reviewer. Do not request code, evaluator, guards, budgets, or frontier-size changes.",
      `Review: ${context.review.reviewId}; trigger: ${context.trigger}; current policy version: ${policy.version}.`,
      `Recent candidate outcomes: ${context.recentOutcomes.join(", ") || "none"}.`,
      `Current tunables: ${JSON.stringify({ ...policy.weights, ...policy.frontier })}`,
      "Submit exactly once with policy_review_submit.",
      "Allowed changes fields only: productivityWeight, explorationWeight, noveltyWeight, coverageWeight, recencyWeight, pairRepetitionPenalty (each 0..2); leanPrimaryTolerance (0..0.25); diversePrimaryTolerance (0..0.5); diverseNoveltyThreshold (0..1); crossoverCadence (integer 1..8).",
      "Your submission must contain a rationale and one or more numeric changes.",
    ].join("\n");
  }
}
