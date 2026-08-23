/**
 * Structured progress events for long-running configuration and calibration
 * work. Callers (the extension tool handler) translate these into live TUI
 * updates; the core stays free of terminal concerns.
 */

export type ConfigureProgressEvent =
  | { stage: "verify-repository"; message: string }
  | { stage: "verify-scope"; message: string }
  | { stage: "dry-run-evaluator"; message: string }
  | { stage: "dry-run-probe"; name: string; message: string }
  | { stage: "dry-run-guard"; name: string; message: string }
  | { stage: "baseline"; sample: number; total: number; message: string }
  | { stage: "verify-baseline-guards"; message: string }
  | { stage: "persist"; message: string };

export type ProgressReporter = (event: ConfigureProgressEvent) => void;

/** A safe default for callers that do not care about progress. */
export function noopProgress(): ProgressReporter {
  return () => {};
}
