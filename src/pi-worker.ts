import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProcessExecutor, ProcessGroupIdentity, WorkerAdapter, WorkerOutcome, WorktreeHandle } from "./adapters.ts";
import type { Assignment, CandidateSubmission, RunSpec } from "./contracts.ts";
import { NodeProcessExecutor } from "./process.ts";
import {
  WORKER_TOOL_ALLOWLIST,
  createWorkerGuardConfig,
  parseCandidateSubmission,
} from "./worker-contract.ts";

export { parseCandidateSubmission } from "./worker-contract.ts";

const DEFAULT_GUARD = fileURLToPath(
  new URL("../extensions/pi-frontier-autoresearch/worker-guard.ts", import.meta.url),
);
const DEFAULT_SKILL = fileURLToPath(new URL("../skills/autoresearch-worker", import.meta.url));

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface PiWorkerOptions {
  executable?: string;
  guardExtension?: string;
  workerSkill?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
  processExecutor?: ProcessExecutor;
  logDirectory?: string;
  maxOutputBytes?: number;
}

function submissionFromOutput(
  stdout: string,
  operator: Assignment["operator"],
): CandidateSubmission | undefined {
  let submission: CandidateSubmission | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const message = event.message as Record<string, unknown> | undefined;
      if (message?.toolName !== "candidate_submit") continue;
      submission = parseCandidateSubmission(message.details, operator);
    } catch {
      // JSON mode may be wrapped by a fixture that also writes plain diagnostics.
    }
  }
  return submission;
}

function reportedCostFromOutput(stdout: string): number | undefined {
  let total = 0;
  let found = false;
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as {
        message?: { role?: string; usage?: { cost?: { total?: number } } };
      };
      const cost = event.message?.role === "assistant" ? event.message.usage?.cost?.total : undefined;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        total += cost;
        found = true;
      }
    } catch {
      // Ignore non-event output.
    }
  }
  return found ? total : undefined;
}

export class PiWorkerAdapter implements WorkerAdapter {
  readonly #options: Required<Pick<PiWorkerOptions, "executable" | "guardExtension" | "workerSkill" | "timeoutMs">> &
    Omit<PiWorkerOptions, "executable" | "guardExtension" | "workerSkill" | "timeoutMs">;
  readonly #process: ProcessExecutor;

  constructor(options: PiWorkerOptions = {}) {
    const inheritedThinking = options.thinkingLevel ?? this.#inheritedThinkingLevel();
    this.#options = {
      ...options,
      executable: options.executable ?? "pi",
      guardExtension: resolve(options.guardExtension ?? DEFAULT_GUARD),
      workerSkill: resolve(options.workerSkill ?? DEFAULT_SKILL),
      model: options.model ?? (process.env.PI_MODEL?.trim() || undefined),
      thinkingLevel: inheritedThinking,
      timeoutMs: options.timeoutMs ?? 15 * 60_000,
    };
    this.#process = options.processExecutor ?? new NodeProcessExecutor();
  }

  async run(
    spec: RunSpec,
    assignment: Assignment,
    worktree: WorktreeHandle,
    signal?: AbortSignal,
    onProcessGroup?: (identity: ProcessGroupIdentity) => void | Promise<void>,
  ): Promise<WorkerOutcome> {
    const config = createWorkerGuardConfig(spec, assignment, worktree);
    const configDirectory = await mkdtemp(resolve(tmpdir(), "pi-frontier-worker-"));
    const configPath = resolve(configDirectory, "guard.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--extension",
      this.#options.guardExtension,
      "--no-skills",
      "--skill",
      this.#options.workerSkill,
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--no-builtin-tools",
      "--tools",
      WORKER_TOOL_ALLOWLIST.join(","),
    ];
    if (this.#options.model) args.push("--model", this.#options.model);
    if (this.#options.thinkingLevel) args.push("--thinking", this.#options.thinkingLevel);
    args.push(this.#prompt(spec, assignment));

    try {
      let process: ProcessGroupIdentity | undefined;
      const result = await this.#process.run(
        {
          command: this.#options.executable,
          args,
          cwd: worktree.path,
          env: { PI_FRONTIER_WORKER_CONFIG: configPath },
          timeoutMs: this.#options.timeoutMs,
          onProcessGroup: async (identity) => {
            process = identity;
            await onProcessGroup?.(identity);
          },
        },
        signal,
      );
      const logPaths = await this.#writeLogs(worktree, assignment.experimentId, result.stdout, result.stderr);
      const stdout = this.#truncateOutput(result.stdout, logPaths.stdout);
      const stderr = this.#truncateOutput(result.stderr, logPaths.stderr);
      const reportedCostUsd = reportedCostFromOutput(result.stdout);
      if (result.cancelled) {
        return { status: "cancelled", stdout, stderr, reportedCostUsd, process, reason: "Worker cancelled" };
      }
      if (result.timedOut) {
        return { status: "timed-out", stdout, stderr, reportedCostUsd, process, reason: "Worker timed out" };
      }
      if (result.exitCode !== 0) {
        return {
          status: "failed",
          stdout,
          stderr,
          reportedCostUsd,
          process,
          reason: `Worker exited with status ${String(result.exitCode)}`,
        };
      }
      const submission = submissionFromOutput(result.stdout, assignment.operator);
      return {
        status: submission ? "submitted" : "failed",
        submission,
        stdout,
        stderr,
        reportedCostUsd,
        process,
        reason: submission ? undefined : "Worker exited without a structured candidate submission",
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: signal?.aborted ? "cancelled" : "failed", stdout: "", stderr: reason, reason };
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  }

  #inheritedThinkingLevel(): ThinkingLevel | undefined {
    const value = process.env.PI_REASONING_LEVEL?.trim();
    if (!value) return undefined;
    if ((THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
    throw new Error(`PI_REASONING_LEVEL is not supported: ${value}`);
  }

  #prompt(spec: RunSpec, assignment: Assignment): string {
    const donor = assignment.operator === "crossover"
      ? `Inspect donor ${assignment.donorParentId ?? "(missing)"} only through inspect_donor.`
      : "Do not make an unrelated second change.";
    return [
      "/skill:autoresearch-worker",
      `Objective: ${spec.objective}`,
      `Experiment: ${assignment.experimentId}`,
      `Assignment: ${assignment.hypothesis}`,
      `Operator: ${assignment.operator}. ${donor}`,
      `Editable paths: ${spec.editableGlobs.join(", ")}`,
      `Protected paths: ${spec.protectedPaths.join(", ") || "none listed"}`,
      `Available probes: ${spec.probes.map((probe) => probe.name).join(", ") || "none"}`,
      "Submit exactly once with candidate_submit after making one coherent change.",
    ].join("\n");
  }

  async #writeLogs(
    worktree: WorktreeHandle,
    experimentId: string,
    stdout: string,
    stderr: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const directory = resolve(this.#options.logDirectory ?? resolve(worktree.path, "..", "..", "logs"));
    await mkdir(directory, { recursive: true });
    const paths = {
      stdout: resolve(directory, `${experimentId}.stdout.log`),
      stderr: resolve(directory, `${experimentId}.stderr.log`),
    };
    await Promise.all([writeFile(paths.stdout, stdout), writeFile(paths.stderr, stderr)]);
    return paths;
  }

  #truncateOutput(output: string, logPath: string): string {
    const maximum = this.#options.maxOutputBytes ?? 50 * 1024;
    const bytes = Buffer.from(output);
    if (bytes.length <= maximum) return output;
    const tail = bytes.subarray(bytes.length - maximum).toString("utf8");
    return `[Output truncated: kept the last ${maximum} of ${bytes.length} bytes. Full output: ${logPath}]\n${tail}`;
  }
}
