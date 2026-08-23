import { resolve } from "node:path";

import type { Clock, ProcessExecutor, StoreAdapter } from "./adapters.ts";
import {
  assertRunSpec,
  type BaselineRecord,
  type MetricSummary,
  type RunSpec,
  type RunState,
} from "./contracts.ts";
import { MetricParseError, parseMetricOutput, summariseSamples } from "./metrics.ts";
import { LOCAL_RUN_GLOB } from "./paths.ts";
import { renderRunSpec } from "./run-spec.ts";

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
}

export interface ConfiguredRun {
  state: RunState;
  generatedSpec: string;
}

export class RunConfigurator {
  readonly #commandExecutor: ProcessExecutor;
  readonly #store: StoreAdapter;
  readonly #clock: Clock;

  constructor(dependencies: ConfiguratorDependencies) {
    this.#commandExecutor = dependencies.commandExecutor;
    this.#store = dependencies.store;
    this.#clock = dependencies.clock;
  }

  async configure(input: unknown, signal?: AbortSignal): Promise<ConfiguredRun> {
    try {
      assertRunSpec(input);
    } catch (error) {
      throw new ConfigurationError(error instanceof Error ? error.message : "Run spec is invalid", { cause: error });
    }
    const spec: RunSpec = {
      ...input,
      protectedPaths: [...new Set([...input.protectedPaths, LOCAL_RUN_GLOB])],
    };
    await this.#verifyRepository(spec, signal);
    this.#verifyScope(spec);
    await this.#dryRunCommands(spec, signal);
    const baseline = await this.#calibrate(spec, signal);
    this.#verifyBaselineGuards(spec, baseline);
    const state: RunState = {
      spec,
      status: "configured",
      baseline,
      nodes: {},
      frontier: [],
      budgetUsage: { experiments: 0, wallTimeMs: 0, reportedCostUsd: 0 },
      policyVersion: 1,
      lastEventIndex: 0,
      latestDecision: "Run configured; use /autoresearch start to begin experiments.",
    };
    const generatedSpec = renderRunSpec(spec, baseline);
    await this.#store.initialise(spec, state);
    await this.#store.writeGeneratedSpec(generatedSpec);
    return { state, generatedSpec };
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

  async #dryRunCommands(spec: RunSpec, signal?: AbortSignal): Promise<void> {
    const evaluator = await this.#requireSuccessfulCommand(spec, spec.evaluator, "Evaluator command", signal);
    const metrics = this.#parseMetrics(spec, evaluator.stdout);
    if (metrics[spec.primaryMetric] === undefined) {
      throw new ConfigurationError(`Configured primary metric "${spec.primaryMetric}" is missing from evaluator output`);
    }

    for (const probe of spec.probes) {
      await this.#requireSuccessfulCommand(spec, probe, `Probe "${probe.name}"`, signal);
    }
    for (const guard of spec.guards) {
      if (guard.type === "command") {
        await this.#requireSuccessfulCommand(spec, guard.command, `Guard "${guard.name}"`, signal);
      }
    }
  }

  async #calibrate(spec: RunSpec, signal?: AbortSignal): Promise<BaselineRecord> {
    const samples = Object.fromEntries(spec.metrics.map((metric) => [metric.name, [] as number[]]));
    let successful = 0;
    for (let index = 0; index < spec.baseline.samples; index += 1) {
      const result = await this.#runCommand(spec, spec.evaluator, signal);
      if (result.exitCode !== 0) continue;
      const metrics = this.#parseMetrics(spec, result.stdout);
      if (metrics[spec.primaryMetric] === undefined) continue;
      successful += 1;
      for (const metric of spec.metrics) {
        const value = metrics[metric.name];
        if (value !== undefined) samples[metric.name]!.push(value);
      }
    }
    if (successful === 0) throw new ConfigurationError("Baseline produced zero successful baseline samples");
    if (successful !== spec.baseline.samples) {
      throw new ConfigurationError(
        `Baseline collected ${successful} of ${spec.baseline.samples} required samples`,
      );
    }
    for (const metric of spec.metrics) {
      if (samples[metric.name]!.length !== successful) {
        throw new ConfigurationError(`Baseline did not emit metric "${metric.name}" for every successful sample`);
      }
    }
    const summaries: Record<string, MetricSummary> = {};
    for (const [name, values] of Object.entries(samples)) summaries[name] = summariseSamples(values);
    return {
      samples,
      summaries,
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
