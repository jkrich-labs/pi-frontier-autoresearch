import type { RunState } from "./contracts.ts";
import type { RunCoordinator } from "./coordinator.ts";

export interface AutoresearchCommandContext {
  cwd: string;
  hasUI?: boolean;
  ui: {
    confirm?(title: string, message: string): Promise<boolean>;
  };
}

export type CoordinatorFactory = (cwd: string) => Promise<RunCoordinator> | RunCoordinator;

export function formatRunStatus(state: RunState): string {
  const best = state.frontier.find((slot) => slot.role === "BEST");
  const bestMetric = best ? state.nodes[best.nodeId]?.metricSamples[state.spec.primaryMetric]?.at(-1) : undefined;
  const budget = state.budgetUsage;
  const lines = [
    `Run ${state.spec.runId}: ${state.status}.`,
    `Experiments: ${budget.experiments}; wall time: ${budget.wallTimeMs} ms; reported cost: US$${budget.reportedCostUsd}.`,
  ];
  if (state.activeAssignment) lines.push(`Current assignment: ${state.activeAssignment.experimentId}.`);
  if (best) lines.push(`Best node: ${best.nodeId}${bestMetric === undefined ? "" : ` (${state.spec.primaryMetric}=${bestMetric})`}.`);
  if (state.latestDecision) lines.push(state.latestDecision);
  return lines.join("\n");
}

/** Routes lifecycle subcommands without coupling coordinator tests to Pi's TUI. */
export class RunCommandRouter {
  readonly #coordinatorFor: CoordinatorFactory;

  constructor(coordinatorFor: CoordinatorFactory) {
    this.#coordinatorFor = coordinatorFor;
  }

  async route(args: string, context: AutoresearchCommandContext): Promise<string> {
    const [action = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (!action) return "Usage: /autoresearch start, pause, resume, status, stop, or clear.";
    const coordinator = await this.#coordinatorFor(context.cwd);
    if (action === "clear") {
      const explicitConfirmation = rest.join(" ").toLowerCase() === "confirm";
      const confirmed = explicitConfirmation || (
        context.hasUI === true && context.ui.confirm
          ? await context.ui.confirm("Clear autoresearch run?", "This removes the local run history. It does not change your main checkout.")
          : false
      );
      if (!confirmed) return "Clear cancelled. Use /autoresearch clear confirm to remove this run without a prompt.";
      await coordinator.clear(true);
      return "Run history cleared.";
    }

    let state: RunState;
    switch (action) {
      case "start":
        await coordinator.recover();
        state = await coordinator.start();
        return formatRunStatus(state);
      case "pause":
        await coordinator.recover();
        state = await coordinator.pause();
        return formatRunStatus(state);
      case "resume":
        await coordinator.recover();
        state = await coordinator.resume();
        return formatRunStatus(state);
      case "stop":
        await coordinator.recover();
        state = await coordinator.stop(rest.join(" ") || "Stopped by user.");
        return formatRunStatus(state);
      case "status":
        state = await coordinator.recover();
        return formatRunStatus(state);
      default:
        return "Usage: /autoresearch start, pause, resume, status, stop, or clear.";
    }
  }
}
