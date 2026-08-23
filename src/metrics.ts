import type { MetricSummary } from "./contracts.ts";

export class MetricParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricParseError";
  }
}

export function parseMetricOutput(
  output: string,
  allowedNames: ReadonlySet<string>,
): Readonly<Record<string, number>> {
  const metrics: Record<string, number> = {};
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("METRIC ")) continue;
    const match = /^METRIC ([A-Za-z][A-Za-z0-9_.-]*)=(\S+)$/.exec(line.trim());
    if (!match) throw new MetricParseError(`Invalid metric line: ${line}`);
    const [, name, rawValue] = match;
    if (!allowedNames.has(name)) throw new MetricParseError(`Metric "${name}" is not declared`);
    if (Object.hasOwn(metrics, name)) throw new MetricParseError(`Metric "${name}" is duplicated`);
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new MetricParseError(`Metric "${name}" must be a finite number`);
    }
    metrics[name] = value;
  }
  return metrics;
}

export function summariseSamples(samples: readonly number[]): MetricSummary {
  if (samples.length === 0) throw new Error("Cannot summarise zero samples");
  const sorted = [...samples].sort((left, right) => left - right);
  const median = middle(sorted);
  const deviations = sorted.map((sample) => Math.abs(sample - median)).sort((left, right) => left - right);
  return {
    median,
    medianAbsoluteDeviation: middle(deviations),
    minimum: sorted[0]!,
    maximum: sorted[sorted.length - 1]!,
  };
}

function middle(sorted: readonly number[]): number {
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2
    : sorted[midpoint]!;
}
