import { resolve } from "node:path";

import type { Clock, ProcessExecutor, StoreAdapter } from "./adapters.ts";
import {
  assertRunSpec,
  type BaselineRecord,
  type RunSpec,
  type RunState,
} from "./contracts.ts";
import { Evaluator } from "./evaluator.ts";
import { MetricParseError, parseMetricOutput } from "./metrics.ts";
import { LOCAL_RUN_GLOB } from "./paths.ts";
import { initialPolicyVersion } from "./policy-tuning.ts";
import { noopProgress, type ProgressReporter } from "./progress.ts";
import { digestRunSpec, renderRunSpec } from "./run-spec.ts";

export class ConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}

export interface ConfiguratorDependencies {
  commandExecutor: ProcessExecutor;
  store: StoreAdapter;
  clock: Clock;
  /** Optional structured progress reporter for long-running configuration work. */
  onProgress?: ProgressReporter;
}

export interface ConfiguredRun {
  state: RunState;
  generatedSpec: string;
}

export class RunConfigurator {
  readonly #commandExecutor: ProcessExecutor;
  readonly #store: StoreAdapter;
  readonly #clock: Clock;

  readonly #onProgress: ProgressReporter | undefined;

  constructor(dependencies: ConfiguratorDependencies) {
    this.#commandExecutor = dependencies.commandExecutor;
    this.#store = dependencies.store;
    this.#clock = dependencies.clock;
    this.#onProgress = dependencies.onProgress;
  }

  async configure(input: unknown, signal?: AbortSignal, onProgress?: ProgressReporter): Promise<ConfiguredRun> {
    const progress = onProgress ?? this.#onProgress ?? noopProgress();
    try {
      assertRunSpec(input);
    } catch (error) {
      throw new ConfigurationError(error instanceof Error ? error.message : "Run spec is invalid", { cause: error });
    }
    await this.#requireNoDurableRun();
    const spec: RunSpec = {
      ...input,
      protectedPaths: [...new Set([...input.protectedPaths, LOCAL_RUN_GLOB])],
    };
    progress({ stage: "verify-repository", message: `Verifying ${spec.targetRepository} is a Git repository root` });
    await this.#verifyRepository(spec, signal);
    progress({ stage: "verify-scope", message: "Checking editable and protected path overlap" });
    this.#verifyScope(spec);
    progress({ stage: "dry-run-evaluator", message: "Dry-running the evaluator command" });
    await this.#dryRunCommands(spec, signal, progress);
    // LocalRunStore claims its empty directory atomically here, before the
    // expensive baseline. Concurrent coordinators therefore cannot both
    // calibrate and later race while overwriting one another's state.
    const initialisationClaim = await this.#store.claimInitialisation(spec);
    progress({ stage: "baseline", sample: 0, total: spec.baseline.samples, message: "Calibrating baseline" });
    const baseline = await this.#calibrate(spec, signal, progress);
    progress({ stage: "verify-baseline-guards", message: "Verifying baseline against metric guards" });
    this.#verifyBaselineGuards(spec, baseline);
    const initialPolicy = initialPolicyVersion(spec.frontierPolicy);
    const state: RunState = {
      spec,
      status: "configured",
      baseline,
      nodes: {},
      frontier: [],
      budgetUsage: { experiments: 0, wallTimeMs: 0, reportedCostUsd: 0 },
      policyVersion: 1,
      activePolicy: initialPolicy,
      policyHistory: [initialPolicy],
      lastEventIndex: 0,
      latestDecision: "Run configured; use /autoresearch start to begin experiments.",
    };
    const generatedSpec = renderRunSpec(spec, baseline);
    progress({ stage: "persist", message: "Persisting configured run state" });
    await this.#store.initialise(spec, state, initialisationClaim);
    const configuredEvent = {
      index: 1,
      type: "run-configured" as const,
      at: new Date(this.#clock.now()).toISOString(),
      runId: spec.runId,
      data: { specDigest: digestRunSpec(spec), spec, baseline },
    };
    await this.#store.append(configuredEvent);
    const persistedState = { ...state, lastEventIndex: configuredEvent.index };
    await this.#store.snapshot(persistedState);
    await this.#store.writeGeneratedSpec(generatedSpec);
    return { state: persistedState, generatedSpec };
  }

  async #requireNoDurableRun(): Promise<void> {
    const existing = await this.#store.load().catch((error: unknown) => {
      throw new ConfigurationError("Cannot verify whether durable run state already exists; clear it explicitly before configuring", {
        cause: error,
      });
    });
    const hasArtifacts = await this.#store.hasRunArtifacts().catch((error: unknown) => {
      throw new ConfigurationError("Cannot verify whether durable run state already exists; clear it explicitly before configuring", {
        cause: error,
      });
    });
    if (existing.events.length > 0 || existing.snapshot || hasArtifacts === true) {
      throw new ConfigurationError("Durable run state already exists; use /autoresearch clear before configuring another run");
    }
  }

  async #verifyRepository(spec: RunSpec, signal?: AbortSignal): Promise<void> {
    const result = await this.#commandExecutor.run(
      { command: "git", args: ["rev-parse", "--show-toplevel"], cwd: spec.targetRepository, timeoutMs: 5_000 },
      signal,
    ).catch(() => undefined);
    if (!result || result.exitCode !== 0) {
      throw new ConfigurationError(`Target is not a Git repository: ${spec.targetRepository}`);
    }
    const root = resolve(result.stdout.trim());
    if (root !== resolve(spec.targetRepository)) {
      throw new ConfigurationError(`Target must be the Git repository root: ${root}`);
    }
  }

  #verifyScope(spec: RunSpec): void {
    for (const editable of spec.editableGlobs) {
      for (const protectedPath of spec.protectedPaths) {
        if (patternsOverlap(editable, protectedPath)) {
          const label = protectedPath === LOCAL_RUN_GLOB ? "generated run state" : `protected path "${protectedPath}"`;
          throw new ConfigurationError(`Editable path "${editable}" overlaps ${label}`);
        }
      }
    }
  }

  async #dryRunCommands(spec: RunSpec, signal?: AbortSignal, onProgress?: ProgressReporter): Promise<void> {
    const evaluator = await this.#requireSuccessfulCommand(spec, spec.evaluator, "Evaluator command", signal);
    const metrics = this.#parseMetrics(spec, evaluator.stdout);
    if (metrics[spec.primaryMetric] === undefined) {
      throw new ConfigurationError(`Configured primary metric "${spec.primaryMetric}" is missing from evaluator output`);
    }

    for (const probe of spec.probes) {
      onProgress?.({ stage: "dry-run-probe", name: probe.name, message: `Dry-running probe "${probe.name}"` });
      await this.#requireSuccessfulCommand(spec, probe, `Probe "${probe.name}"`, signal);
    }
    for (const guard of spec.guards) {
      if (guard.type === "command") {
        onProgress?.({ stage: "dry-run-guard", name: guard.name, message: `Dry-running guard "${guard.name}"` });
        await this.#requireSuccessfulCommand(spec, guard.command, `Guard "${guard.name}"`, signal);
      }
    }
  }

  async #calibrate(spec: RunSpec, signal?: AbortSignal, onProgress?: ProgressReporter): Promise<BaselineRecord> {
    const calibration = await new Evaluator({ commandExecutor: this.#commandExecutor }).calibrate(spec, signal, onProgress);
    if (calibration.guards.some((guard) => guard.name === "evaluator" && guard.status === "failed")) {
      throw new ConfigurationError(calibration.reason);
    }
    return {
      samples: calibration.samples,
      summaries: calibration.summaries,
      calibratedAt: new Date(this.#clock.now()).toISOString(),
    };
  }

  #verifyBaselineGuards(spec: RunSpec, baseline: BaselineRecord): void {
    const thresholds = [
      ...spec.metrics
        .filter((metric) => metric.guard !== undefined)
        .map((metric) => ({ metric: metric.name, ...metric.guard! })),
      ...spec.guards.filter((guard) => guard.type === "metric"),
    ];
    for (const threshold of thresholds) {
      const value = baseline.summaries[threshold.metric]?.median;
      if (
        value === undefined ||
        (threshold.minimum !== undefined && value < threshold.minimum) ||
        (threshold.maximum !== undefined && value > threshold.maximum)
      ) {
        throw new ConfigurationError(
          `Baseline violates metric guard for "${threshold.metric}": ${String(value)}`,
        );
      }
    }
  }

  async #requireSuccessfulCommand(
    spec: RunSpec,
    command: RunSpec["evaluator"],
    label: string,
    signal?: AbortSignal,
  ) {
    const result = await this.#runCommand(spec, command, signal);
    if (result.exitCode !== 0) {
      throw new ConfigurationError(`${label} failed with exit code ${String(result.exitCode)}`);
    }
    return result;
  }

  async #runCommand(spec: RunSpec, command: RunSpec["evaluator"], signal?: AbortSignal) {
    return await this.#commandExecutor.run(
      {
        command: "/bin/sh",
        args: ["-c", command.command],
        cwd: spec.targetRepository,
        env: command.env,
        timeoutMs: command.timeoutMs,
      },
      signal,
    );
  }

  #parseMetrics(spec: RunSpec, stdout: string): Readonly<Record<string, number>> {
    try {
      return parseMetricOutput(stdout, new Set(spec.metrics.map((metric) => metric.name)));
    } catch (error) {
      if (error instanceof MetricParseError) throw new ConfigurationError(error.message, { cause: error });
      throw error;
    }
  }
}

function staticPrefix(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const wildcard = normalized.search(/[?*[\]{}]/);
  return (wildcard === -1 ? normalized : normalized.slice(0, wildcard)).replace(/\/+$/, "");
}

function patternsOverlap(left: string, right: string): boolean {
  const leftPrefix = staticPrefix(left);
  const rightPrefix = staticPrefix(right);
  if (!leftPrefix || !rightPrefix) return true;
  return (
    leftPrefix === rightPrefix ||
    leftPrefix.startsWith(`${rightPrefix}/`) ||
    rightPrefix.startsWith(`${leftPrefix}/`)
  );
}
