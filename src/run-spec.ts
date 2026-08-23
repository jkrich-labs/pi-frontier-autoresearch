import { createHash } from "node:crypto";

import type { BaselineRecord, Budget, RunSpec } from "./contracts.ts";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestRunSpec(spec: RunSpec): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

function renderBudget(budget: Budget): string {
  const limits: string[] = [];
  if (budget.maxExperiments !== undefined) limits.push(`${budget.maxExperiments} experiments`);
  if (budget.maxWallTimeMs !== undefined) limits.push(`${budget.maxWallTimeMs} ms wall time`);
  if (budget.maxReportedCostUsd !== undefined) limits.push(`US$${budget.maxReportedCostUsd} reported model cost`);
  if (budget.unlimited) limits.push("explicitly unlimited");
  return limits.join(", ");
}

export function renderRunSpec(spec: RunSpec, baseline: BaselineRecord): string {
  const primary = baseline.summaries[spec.primaryMetric];
  const metricLines = spec.metrics.map((metric) => {
    const guard = metric.guard ? `; guard ${JSON.stringify(metric.guard)}` : "";
    return `- ${metric.name} (${metric.direction} is better${guard})`;
  });
  const guardLines = spec.guards.length === 0
    ? ["- No additional guards are configured."]
    : spec.guards.map((guard) => `- ${guard.type}: ${JSON.stringify(guard)}`);
  return [
    "# Frontier autoresearch run",
    "",
    `Configuration digest: ${digestRunSpec(spec)}`,
    "",
    "## Objective",
    "",
    spec.objective,
    "",
    "## Worker steps",
    "",
    "1. Make one coherent assigned change within the editable scope.",
    "2. Use only configured probes for feedback.",
    "3. Submit the hypothesis, change, expected effect, and reflection.",
    "",
    "## Evaluation contract",
    "",
    `Primary metric: ${spec.primaryMetric}`,
    "",
    ...metricLines,
    "",
    `- Run command: ${spec.evaluator.command}`,
    `- Baseline median: ${primary?.median ?? "unavailable"}`,
    `- Baseline noise (median absolute deviation): ${primary?.medianAbsoluteDeviation ?? "unavailable"}`,
    "",
    "## Scope and off-limits paths",
    "",
    `- Editable scope: ${spec.editableGlobs.join(", ")}`,
    `- Off-limits paths: ${spec.protectedPaths.join(", ") || "none"}`,
    "",
    "## Guards",
    "",
    ...guardLines,
    "",
    "## Budget",
    "",
    `- ${renderBudget(spec.budget)}`,
    "",
    "## Completion criteria",
    "",
    "A candidate completes only when its diff stays in scope, every guard passes, the controller parses all required metrics, and the controller records a frontier decision. The run stops before a new assignment when any configured budget is exhausted.",
    "",
  ].join("\n");
}
