import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { Assignment, Budget, FrontierSlot, RunState } from "./contracts.ts";

/**
 * A plain-text, width-safe projection of durable run state. Keeping this renderer
 * free of extension state and terminal control sequences makes it snapshot-testable
 * and usable by both the Pi widget and command/event fallbacks.
 */
export function renderFrontierStatus(
  state: RunState | undefined,
  width: number,
  refreshFailure?: string,
): string[] {
  if (width <= 0) return [];
  if (refreshFailure) {
    return reflow([
      "Frontier: status refresh failed.",
      `Error: ${refreshFailure}`,
    ], width);
  }
  if (!state) return reflow(["Frontier: no configured run."], width);

  const metric = state.spec.primaryMetric;
  const baseline = state.baseline?.summaries[metric]?.median;
  const best = bestMetric(state);
  const roles = roleLines(state.frontier);
  const budgetLine = `Budget: ${remainingBudget(state.spec.budget, state.budgetUsage)}`;
  const metricLine = `Metric: ${metric} baseline=${valueOrUnknown(baseline)} best=${valueOrUnknown(best)}`;
  const activeLine = `Active: ${assignmentText(state.activeAssignment)}`;
  const decisionLine = `Decision: ${state.latestDecision ?? "No frontier decision recorded."}`;
  const policyLine = `Policy: ${state.spec.policyTuning?.enabled ? "experimental" : "fixed"} v${state.activePolicy.version}`;
  const lines = width >= 96
    ? [
      `Frontier: ${displayState(state)} | ${budgetLine}`,
      metricLine,
      activeLine,
      `BEST: ${roles.best} | LEAN: ${roles.lean}`,
      `DIVERSE 1: ${roles.diverseOne} | DIVERSE 2: ${roles.diverseTwo}`,
      decisionLine,
      policyLine,
    ]
    : width >= 64
      ? [
        `Frontier: ${displayState(state)}`,
        budgetLine,
        metricLine,
        activeLine,
        `BEST: ${roles.best} | LEAN: ${roles.lean}`,
        `DIVERSE 1: ${roles.diverseOne} | DIVERSE 2: ${roles.diverseTwo}`,
        decisionLine,
        policyLine,
      ]
      : [
        `Frontier: ${displayState(state)}`,
        budgetLine,
        metricLine,
        activeLine,
        `BEST: ${roles.best}`,
        `LEAN: ${roles.lean}`,
        `DIVERSE 1: ${roles.diverseOne}`,
        `DIVERSE 2: ${roles.diverseTwo}`,
        decisionLine,
        policyLine,
      ];
  return reflow(lines, width);
}

/** A terse state-only footer; responsive detail belongs in the widget. */
export function renderFrontierFooter(state: RunState | undefined, refreshFailure?: string): string {
  if (refreshFailure) return "Frontier: status refresh failed";
  if (!state) return "Frontier: no configured run";
  return `Frontier: ${displayState(state)}`;
}

function displayState(state: RunState): string {
  return state.status === "completed" && budgetExhausted(state.spec.budget, state.budgetUsage)
    ? "budget exhausted"
    : state.status;
}

function remainingBudget(budget: Budget, usage: RunState["budgetUsage"]): string {
  const parts: string[] = [];
  if (budget.maxExperiments !== undefined) {
    parts.push(`${Math.max(0, budget.maxExperiments - usage.experiments)}/${budget.maxExperiments} experiments`);
  }
  if (budget.maxWallTimeMs !== undefined) {
    parts.push(`${duration(Math.max(0, budget.maxWallTimeMs - usage.wallTimeMs))} wall time`);
  }
  if (budget.maxReportedCostUsd !== undefined) {
    parts.push(`US$${number(Math.max(0, budget.maxReportedCostUsd - usage.reportedCostUsd))} cost`);
  }
  return parts.length > 0 ? parts.join(", ") : "explicitly unlimited";
}

function budgetExhausted(budget: Budget, usage: RunState["budgetUsage"]): boolean {
  return (budget.maxExperiments !== undefined && usage.experiments >= budget.maxExperiments)
    || (budget.maxWallTimeMs !== undefined && usage.wallTimeMs >= budget.maxWallTimeMs)
    || (budget.maxReportedCostUsd !== undefined && usage.reportedCostUsd >= budget.maxReportedCostUsd);
}

function duration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function valueOrUnknown(value: number | undefined): string {
  return value === undefined ? "--" : number(value);
}

function bestMetric(state: RunState): number | undefined {
  const best = state.frontier.find((slot) => slot.role === "BEST");
  return best ? state.nodes[best.nodeId]?.metricSamples[state.spec.primaryMetric]?.at(-1) : undefined;
}

function assignmentText(assignment: Assignment | undefined): string {
  if (!assignment) return "none";
  return `${assignment.experimentId} ${assignment.operator} ${assignment.primaryParentId}${assignment.donorParentId ? ` + ${assignment.donorParentId}` : ""}`;
}

function roleLines(slots: readonly FrontierSlot[]): {
  best: string;
  lean: string;
  diverseOne: string;
  diverseTwo: string;
} {
  const byIndex = new Map(slots.map((slot) => [slot.index, slot.nodeId]));
  return {
    best: byIndex.get(0) ?? "--",
    lean: byIndex.get(1) ?? "--",
    diverseOne: byIndex.get(2) ?? "--",
    diverseTwo: byIndex.get(3) ?? "--",
  };
}

/** Pi's ANSI-aware wrapper also splits long unbroken grapheme sequences. */
function reflow(lines: readonly string[], width: number): string[] {
  return lines.flatMap((line) => wrapTextWithAnsi(line, width));
}
