import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  ConfigurationError,
  Evaluator,
  GitWorkspaceAdapter,
  LocalRunStore,
  NodeProcessExecutor,
  PiWorkerAdapter,
  RunCommandRouter,
  RunConfigurator,
  RunCoordinator,
  SystemClock,
  FrontierStatusPresenter,
  type ConfigureProgressEvent,
  type ProgressReporter,
  type RunSpec,
} from "../../src/index.ts";
import { detectAutoresearchCommandConflict } from "../../src/command-conflict.ts";

const CONFIGURE_TOOL = "autoresearch_configure";
const LIFECYCLE_ACTIONS = new Set(["start", "pause", "resume", "status", "stop", "clear"]);
const CONFLICT_WARNING_HOSTS = Symbol.for("pi-frontier-autoresearch.conflict-warning-hosts");
const PROGRESS_THROTTLE_MS = 250;

/**
 * Throttled bridge from structured configure progress into the tool's live
 * partial-result updates. Mirrors the bash tool's streaming pattern so the TUI
 * tool row renders each stage as it happens instead of staying blank. The
 * returned flush() emits any trailing pending stage immediately, so the last
 * visible line always reflects the latest stage even when work completes faster
 * than the throttle window.
 */
function throttledProgress(
  onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
): { report: ProgressReporter | undefined; flush: () => void } {
  if (!onUpdate) return { report: undefined, flush: () => {} };
  let lastEmit = 0;
  let pending: ConfigureProgressEvent | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const emit = (event: ConfigureProgressEvent): void => {
    pending = undefined;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    lastEmit = Date.now();
    const text = progressLine(event);
    onUpdate({ content: [{ type: "text", text }], details: { progress: text } });
  };
  const schedule = (event: ConfigureProgressEvent): void => {
    pending = event;
    if (timer) return;
    const delay = PROGRESS_THROTTLE_MS - (Date.now() - lastEmit);
    if (delay <= 0) {
      emit(event);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (pending) emit(pending);
    }, delay);
  };
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending) emit(pending);
  };
  return { report: (event) => schedule(event), flush };
}

function progressLine(event: ConfigureProgressEvent): string {
  switch (event.stage) {
    case "verify-repository":
    case "verify-scope":
    case "dry-run-evaluator":
    case "verify-baseline-guards":
    case "persist":
      return event.message;
    case "dry-run-probe":
      return `Dry-running probe "${event.name}"`;
    case "dry-run-guard":
      return `Dry-running guard "${event.name}"`;
    case "baseline":
      return event.sample === 0
        ? `Calibrating baseline (${event.total} samples)`
        : `Calibrating baseline: sample ${event.sample} of ${event.total}`;
  }
}

function parseRunId(config: unknown): string | undefined {
  if (typeof config !== "string") return undefined;
  try {
    const parsed = JSON.parse(config) as { runId?: unknown };
    return typeof parsed.runId === "string" && parsed.runId ? parsed.runId : undefined;
  } catch {
    return undefined;
  }
}

async function coordinatorFor(cwd: string): Promise<RunCoordinator> {
  const store = new LocalRunStore(cwd);
  const loaded = await store.load();
  const configured = loaded.events.find((event) => event.type === "run-configured");
  const spec = configured?.type === "run-configured" ? configured.data.spec : loaded.snapshot?.spec;
  if (!spec) throw new Error("No configured frontier autoresearch run was found.");
  const clock = new SystemClock();
  const processExecutor = new NodeProcessExecutor(clock);
  const workspace = new GitWorkspaceAdapter({ repository: spec.targetRepository, runId: spec.runId, processExecutor });
  return new RunCoordinator({
    store,
    workspace,
    worker: new PiWorkerAdapter({ processExecutor }),
    evaluator: new Evaluator({ commandExecutor: processExecutor, workspace }),
    clock,
    processExecutor,
  });
}

function activateConfigureTool(pi: ExtensionAPI): void {
  const active = pi.getActiveTools();
  if (!active.includes(CONFIGURE_TOOL)) pi.setActiveTools([...active, CONFIGURE_TOOL]);
}

function isSetupInvocation(text: string): boolean {
  const input = text.trimStart();
  return input.startsWith("/skill:autoresearch-setup") ||
    /^<skill\b[^>]*\bname=["']autoresearch-setup["']/.test(input);
}

function sendSetupPrompt(pi: ExtensionAPI, roughGoal: string, notify: (message: string) => void): void {
  const goal = roughGoal.trim();
  if (!goal) {
    notify("Add a mechanical optimisation goal, for example: /autoresearch-prompt reduce build time");
    return;
  }
  activateConfigureTool(pi);
  pi.sendUserMessage(`/skill:autoresearch-setup ${goal}`, { expandPromptTemplates: true });
}

function reportCommand(pi: ExtensionAPI, ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.mode === "print") {
    // Print mode emits only a final assistant response, so command results must
    // be written explicitly rather than relying on a custom-message event.
    process.stdout.write(`${message}\n`);
    return;
  }
  // The undefined branch preserves compatibility with minimal embedding test
  // contexts from before Pi exposed ctx.mode; real Pi contexts always set it.
  if (ctx.mode === "tui" || ctx.mode === undefined) {
    ctx.ui.notify(message, level);
    return;
  }
  // JSON/RPC custom messages become structured message events without using
  // terminal-only notification or widget APIs.
  pi.sendMessage({ customType: "frontier-autoresearch-command", content: message, display: true }, { triggerTurn: false });
}

function conflictWarningHosts(): WeakSet<object> {
  const globalState = globalThis as typeof globalThis & Record<symbol, WeakSet<object> | undefined>;
  return globalState[CONFLICT_WARNING_HOSTS] ??= new WeakSet<object>();
}

interface ExtensionRuntime {
  readonly coordinators: Map<string, Promise<RunCoordinator>>;
  readonly recoveredCoordinators: Set<string>;
  readonly router: RunCommandRouter;
  readonly presenter: FrontierStatusPresenter;
}

function createExtensionRuntime(): ExtensionRuntime {
  const coordinators = new Map<string, Promise<RunCoordinator>>();
  const recoveredCoordinators = new Set<string>();

  function routerCoordinator(cwd: string): Promise<RunCoordinator> {
    const existing = coordinators.get(cwd);
    if (existing) return existing;
    const created = coordinatorFor(cwd);
    coordinators.set(cwd, created);
    void created.catch(() => {
      if (coordinators.get(cwd) === created) coordinators.delete(cwd);
    });
    return created;
  }

  const router = new RunCommandRouter(routerCoordinator);
  const presenter = new FrontierStatusPresenter(async (cwd) => {
    try {
      const coordinator = await routerCoordinator(cwd);
      if (recoveredCoordinators.has(cwd)) return coordinator.status();
      const state = await coordinator.recover();
      recoveredCoordinators.add(cwd);
      return state;
    } catch (error) {
      if (error instanceof Error && error.message === "No configured frontier autoresearch run was found.") return undefined;
      throw error;
    }
  });
  return { coordinators, recoveredCoordinators, router, presenter };
}

export default function frontierAutoresearch(pi: ExtensionAPI): void {
  registerFrontierAutoresearch(pi);
}

/** Injecting the runtime boundary keeps conflict handling free of run state. */
export function registerFrontierAutoresearch(
  pi: ExtensionAPI,
  createRuntime: () => ExtensionRuntime = createExtensionRuntime,
): void {
  let runtime: ExtensionRuntime | undefined;
  const runtimeFor = (): ExtensionRuntime => runtime ??= createRuntime();

  pi.registerTool({
    name: CONFIGURE_TOOL,
    label: "Configure autoresearch",
    description:
      "Validate and persist one frontier autoresearch run from an authoritative RunSpec JSON object. This tool calibrates a baseline but never starts experiments.",
    parameters: Type.Object({
      config: Type.String({ description: "Complete RunSpec as JSON" }),
    }),
    renderCall(args, theme) {
      const runId = parseRunId(args?.config);
      let content = theme.fg("toolTitle", theme.bold("Configure autoresearch"));
      if (runId) content += ` ${theme.fg("muted", runId)}`;
      return new Text(content, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const details = result.details as { progress?: string } | undefined;
      const text = details?.progress ?? (result.content?.[0]?.type === "text" ? result.content[0].text : undefined);
      if (isPartial) {
        return new Text(theme.fg("warning", text ? `⟳ ${text}` : "Working..."), 0, 0);
      }
      return new Text(theme.fg("success", "✓ Run configured"), 0, 0);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let spec: RunSpec;
      try {
        spec = JSON.parse(params.config) as RunSpec;
      } catch (error) {
        throw new ConfigurationError("Configuration must be valid JSON", { cause: error });
      }
      const store = new LocalRunStore(spec.targetRepository);
      const configurator = new RunConfigurator({
        commandExecutor: new NodeProcessExecutor(),
        store,
        clock: new SystemClock(),
      });
      const progress = throttledProgress(onUpdate);
      let configured;
      try {
        configured = await configurator.configure(spec, signal, progress.report);
      } finally {
        progress.flush();
      }
      await runtimeFor().presenter.refresh(ctx);
      return {
        content: [
          {
            type: "text",
            text: `${configured.generatedSpec}\nRun configured. Review it, then use /autoresearch start to begin experiments.`,
          },
        ],
        details: { state: configured.state, generatedSpec: configured.generatedSpec },
      };
    },
  });

  pi.registerCommand("autoresearch-prompt", {
    description: "Turn a rough optimisation goal into a validated run",
    handler: async (args, ctx) => {
      sendSetupPrompt(pi, args, (message) => reportCommand(pi, ctx, message, "warning"));
    },
  });

  pi.registerCommand("autoresearch", {
    description: "Set up or control frontier autoresearch",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [action] = trimmed.split(/\s+/, 1);
      if (LIFECYCLE_ACTIONS.has(action ?? "")) {
        try {
          const activeRuntime = runtimeFor();
          const result = await activeRuntime.router.route(trimmed, {
            cwd: ctx.cwd,
            hasUI: ctx.hasUI,
            ui: ctx.ui,
          });
          await activeRuntime.presenter.refresh(ctx);
          reportCommand(pi, ctx, result, "info");
        } catch (error) {
          reportCommand(pi, ctx, `Autoresearch command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      sendSetupPrompt(pi, trimmed, (message) => reportCommand(pi, ctx, message, "warning"));
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const conflict = detectAutoresearchCommandConflict(pi.getCommands());
    if (conflict) {
      const warnedHosts = conflictWarningHosts();
      if (!warnedHosts.has(pi)) {
        warnedHosts.add(pi);
        reportCommand(
          pi,
          ctx,
          `/autoresearch conflict: ${conflict.ours} and ${conflict.other} both register this command; this package will not inspect or migrate legacy run state.`,
          "warning",
        );
      }
      return;
    }

    const active = pi.getActiveTools().filter((name) => name !== CONFIGURE_TOOL);
    pi.setActiveTools(active);
    await runtimeFor().presenter.start(ctx);
  });

  // A direct /skill:autoresearch-setup invocation, or an already-expanded
  // <skill name="autoresearch-setup"> message, bypasses sendSetupPrompt and its
  // tool activation. Activate the configure tool whenever the setup skill enters
  // through the input pipeline so the agent can persist the validated RunSpec.
  pi.on("input", (event) => {
    if (isSetupInvocation(event.text)) activateConfigureTool(pi);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!runtime) return;
    await runtime.presenter.shutdown(ctx);
    const owned = [...runtime.coordinators.values()];
    runtime.coordinators.clear();
    runtime.recoveredCoordinators.clear();
    await Promise.all(owned.map(async (coordinator) => {
      try {
        await (await coordinator).stop("Pi session ended.");
      } catch {
        // A configured, completed, or absent run needs no shutdown action.
      }
    }));
  });
}
