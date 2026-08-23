import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  POLICY_REVIEW_PROPOSAL_PARAMETERS,
  validatePolicyProposal,
} from "../../src/policy-tuning.ts";

function text(content: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: content }], details };
}

/** The review child has no filesystem, shell, evaluator, or mutation tools. */
export default function policyReviewGuard(pi: ExtensionAPI): void {
  let submitted = false;
  pi.registerTool({
    name: "policy_review_submit",
    label: "Submit bounded policy proposal",
    description: "Submit exactly one rationale plus allowed numeric policy changes.",
    // This intentionally accepts unknown JSON at the tool boundary. The trusted
    // guard turns every malformed call into a bounded audit result rather than
    // letting host schema rejection erase the worker's attempted submission.
    parameters: POLICY_REVIEW_PROPOSAL_PARAMETERS,
    async execute(_id, params) {
      if (submitted) throw new Error("A policy review proposal has already been recorded");
      // Validate against an inert version only to reject malformed, forbidden, and
      // out-of-bound fields at the child boundary. The coordinator revalidates a
      // normalized proposal against its live immutable policy.
      const validation = validatePolicyProposal({
        version: 1,
        frontier: {
          size: 4,
          leanPrimaryTolerance: 0.1,
          diversePrimaryTolerance: 0.1,
          diverseNoveltyThreshold: 0.1,
          crossoverCadence: 2,
        },
        weights: {
          productivity: 1,
          exploration: 0.7,
          novelty: 0.35,
          coverage: 0.25,
          recency: 0.2,
          pairRepetitionPenalty: 0.8,
        },
      }, params);
      submitted = true;
      // A no-op against the inert policy can still change the coordinator's live
      // policy after an earlier review. It has already passed all bounded shape and
      // range checks, so forwarding this small allowlisted object is safe.
      const noOpAgainstInertPolicy = !validation.accepted &&
        validation.reason === "Policy proposal does not change the active policy.";
      const proposal = noOpAgainstInertPolicy ? structuredClone(params) : validation.proposal;
      const reason = validation.accepted ? "Policy proposal accepted." : validation.reason;
      return {
        ...text(validation.accepted ? "Policy proposal recorded" : "Policy proposal rejected", {
          policyReviewProposal: proposal,
          accepted: validation.accepted,
          reason,
          ...(validation.accepted ? {} : { proposal: validation.proposal }),
        }),
        terminate: true,
      };
    },
  });
  pi.on("session_start", () => pi.setActiveTools(["policy_review_submit"]));
  pi.on("tool_call", (event) => {
    if (event.toolName !== "policy_review_submit") {
      return { block: true, reason: "Only policy_review_submit is available to policy reviewers." };
    }
    return undefined;
  });
}
