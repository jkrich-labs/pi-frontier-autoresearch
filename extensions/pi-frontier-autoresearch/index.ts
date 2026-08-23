import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  ConfigurationError,
  LocalRunStore,
  NodeProcessExecutor,
  RunConfigurator,
  SystemClock,
  type RunSpec,
} from "../../src/index.ts";

const CONFIGURE_TOOL = "autoresearch_configure";
const LIFECYCLE_ACTIONS = new Set(["start", "pause", "resume", "status", "stop", "clear"]);

function activateConfigureTool(pi: ExtensionAPI): void {
  const active = pi.getActiveTools();
  if (!active.includes(CONFIGURE_TOOL)) pi.setActiveTools([...active, CONFIGURE_TOOL]);
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

export default function frontierAutoresearch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: CONFIGURE_TOOL,
    label: "Configure autoresearch",
    description:
      "Validate and persist one frontier autoresearch run from an authoritative RunSpec JSON object. This tool calibrates a baseline but never starts experiments.",
    parameters: Type.Object({
      config: Type.String({ description: "Complete RunSpec as JSON" }),
    }),
    async execute(_toolCallId, params, signal) {
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
      const configured = await configurator.configure(spec, signal);
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
      sendSetupPrompt(pi, args, (message) => ctx.ui.notify(message, "warning"));
    },
  });

  pi.registerCommand("autoresearch", {
    description: "Set up or control frontier autoresearch",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [action] = trimmed.split(/\s+/, 1);
      if (LIFECYCLE_ACTIONS.has(action ?? "")) {
        ctx.ui.notify(`/${`autoresearch ${action}`} is available after the run coordinator is loaded.`, "info");
        return;
      }
      sendSetupPrompt(pi, trimmed, (message) => ctx.ui.notify(message, "warning"));
    },
  });

  pi.on("session_start", () => {
    const active = pi.getActiveTools().filter((name) => name !== CONFIGURE_TOOL);
    pi.setActiveTools(active);
  });
}
