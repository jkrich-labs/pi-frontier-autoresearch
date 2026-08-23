import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { matchesGlob, relative, resolve, sep } from "node:path";

import type { EvaluatorAdapter, GitWorkspacePort, ProcessExecutor, ProcessResult, WorktreeHandle } from "./adapters.ts";
import type {
  CommandSpec,
  ConfirmationEvidence,
  Evaluation,
  EvaluationLog,
  FrontierRole,
  GuardResult,
  MetricDirection,
  NodeRecord,
  PromotionGate,
  RunSpec,
} from "./contracts.ts";
import { MetricParseError, parseMetricOutput, summariseSamples } from "./metrics.ts";
import { LOCAL_RUN_DIRECTORY } from "./paths.ts";
import { WorkerConfinement } from "./worker-confinement.ts";

const MAD_SCALE = 1.4826;

export interface EvaluatorDependencies {
  commandExecutor: ProcessExecutor;
  workspace?: GitWorkspacePort;
  logDirectory?: string;
  maxOutputBytes?: number;
}

interface CommandAttempt {
  result: ProcessResult;
  log: EvaluationLog;
}

interface MetricAttempt {
  metrics?: Record<string, number>;
  problem?: string;
  verification?: CommandVerification;
}

interface DiffInspection {
  valid: boolean;
  changedLines: number;
  detail?: string;
}

interface ProtectedTreeResult {
  intact: boolean;
  detail?: string;
}

interface WorktreeIntegrity {
  intact: boolean;
  detail?: string;
}

interface CommandVerification {
  worktree: WorktreeIntegrity;
  protectedTree: ProtectedTreeResult;
}

function normalisePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function matchesProtectedPath(path: string, pattern: string): boolean {
  const normalized = normalisePath(pattern);
  if (!/[?*[\]{}]/.test(normalized)) {
    return path === normalized || path.startsWith(`${normalized}/`);
  }
  try {
    if (matchesGlob(path, normalized)) return true;
  } catch {
    return false;
  }
  return normalized.endsWith("/**") && path === normalized.slice(0, -3);
}

function summaries(samples: Readonly<Record<string, readonly number[]>>) {
  return Object.fromEntries(
    Object.entries(samples)
      .filter(([, values]) => values.length > 0)
      .map(([name, values]) => [name, summariseSamples(values)]),
  );
}

function metricDirection(spec: RunSpec): MetricDirection {
  return spec.metrics.find((metric) => metric.name === spec.primaryMetric)!.direction;
}

function requiredMetricNames(spec: RunSpec, requireAll = false): Set<string> {
  const required = new Set<string>([spec.primaryMetric]);
  if (requireAll) {
    for (const metric of spec.metrics) required.add(metric.name);
    return required;
  }
  for (const metric of spec.metrics) {
    if (metric.guard) required.add(metric.name);
  }
  for (const guard of spec.guards) {
    if (guard.type === "metric") required.add(guard.metric);
  }
  return required;
}

function boundedOutput(value: string, maximum: number, fullLogPath: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximum) return { text: value, truncated: false };
  return {
    text: `${bytes.subarray(0, maximum).toString("utf8")}\nOutput truncated at ${maximum} bytes. Full output: ${fullLogPath}`,
    truncated: true,
  };
}

function firstFailedGuard(guards: readonly GuardResult[]): GuardResult | undefined {
  return guards.find((guard) => guard.status === "failed");
}

function metricGuardResults(
  spec: RunSpec,
  values: Readonly<Record<string, readonly number[]>>,
  requireEverySample = false,
): GuardResult[] {
  const results: GuardResult[] = [];
  const check = (name: string, metric: string, minimum?: number, maximum?: number): void => {
    const samples = values[metric];
    if (!samples?.length) {
      results.push({ name, status: "failed", detail: `Metric "${metric}" is missing` });
      return;
    }
    const checked = requireEverySample ? samples : [summariseSamples(samples).median];
    const below = minimum === undefined ? undefined : checked.find((value) => value < minimum);
    if (below !== undefined) {
      results.push({ name, status: "failed", detail: `Metric "${metric}" sample ${below} is below ${minimum}` });
      return;
    }
    const above = maximum === undefined ? undefined : checked.find((value) => value > maximum);
    if (above !== undefined) {
      results.push({ name, status: "failed", detail: `Metric "${metric}" sample ${above} exceeds ${maximum}` });
      return;
    }
    results.push({ name, status: "passed" });
  };
  for (const metric of spec.metrics) {
    if (metric.guard) check(`metric ${metric.name}`, metric.name, metric.guard.minimum, metric.guard.maximum);
  }
  for (const guard of spec.guards) {
    if (guard.type === "metric") check(`metric ${guard.metric}`, guard.metric, guard.minimum, guard.maximum);
  }
  return results;
}

function robustPairedDecision(
  pairedSamples: readonly { parent: Readonly<Record<string, number>>; candidate: Readonly<Record<string, number>> }[],
  primaryMetric: string,
  direction: MetricDirection,
  multiplier: number,
): "confirmed" | "rejected" | "inconclusive" {
  const deltas = pairedSamples.map(({ parent, candidate }) => direction === "higher"
    ? candidate[primaryMetric]! - parent[primaryMetric]!
    : parent[primaryMetric]! - candidate[primaryMetric]!);
  const summary = summariseSamples(deltas);
  const margin = multiplier * MAD_SCALE * summary.medianAbsoluteDeviation / Math.sqrt(deltas.length);
  if (summary.median > margin) return "confirmed";
  if (summary.median < -margin) return "rejected";
  return "inconclusive";
}

export class ProtectedTreeVerifier {
  async compare(parentRoot: string, candidateRoot: string, protectedPaths: readonly string[]): Promise<ProtectedTreeResult> {
    const [parent, candidate] = await Promise.all([
      this.#snapshot(parentRoot, protectedPaths),
      this.#snapshot(candidateRoot, protectedPaths),
    ]);
    return this.#compare(parent, candidate);
  }

  async unchanged(
    root: string,
    expected: ReadonlyMap<string, string>,
    protectedPaths: readonly string[],
  ): Promise<ProtectedTreeResult> {
    return this.#compare(expected, await this.#snapshot(root, protectedPaths));
  }

  async snapshot(root: string, protectedPaths: readonly string[]): Promise<ReadonlyMap<string, string>> {
    return this.#snapshot(root, protectedPaths);
  }

  async #snapshot(root: string, protectedPaths: readonly string[]): Promise<Map<string, string>> {
    const entries = new Map<string, string>();
    if (protectedPaths.length === 0) return entries;
    const visit = async (absolute: string, relativePath: string): Promise<void> => {
      const stat = await lstat(absolute);
      if (relativePath && protectedPaths.some((pattern) => matchesProtectedPath(relativePath, pattern))) {
        const hash = createHash("sha256");
        if (stat.isFile()) {
          hash.update("file\0");
          hash.update(await readFile(absolute));
        } else if (stat.isSymbolicLink()) {
          hash.update("symlink\0");
          hash.update(await readlink(absolute));
        } else if (stat.isDirectory()) {
          hash.update("directory\0");
        } else {
          hash.update(`other\0${String(stat.mode)}`);
        }
        entries.set(relativePath, hash.digest("hex"));
      }
      if (!stat.isDirectory() || relativePath === ".git") return;
      const children = await readdir(absolute);
      children.sort();
      for (const child of children) {
        const childRelative = relativePath ? `${relativePath}/${child}` : child;
        if (childRelative === ".git") continue;
        await visit(resolve(absolute, child), childRelative);
      }
    };
    await visit(resolve(root), "");
    return entries;
  }

  #compare(expected: ReadonlyMap<string, string>, actual: ReadonlyMap<string, string>): ProtectedTreeResult {
    const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
    for (const path of paths) {
      if (expected.get(path) !== actual.get(path)) {
        return { intact: false, detail: `Protected path changed: ${path}` };
      }
    }
    return { intact: true };
  }
}

export class Evaluator implements EvaluatorAdapter {
  readonly #commandExecutor: ProcessExecutor;
  readonly #workspace?: GitWorkspacePort;
  readonly #logDirectory?: string;
  readonly #maxOutputBytes: number;
  #logSequence = 0;

  constructor(dependencies: EvaluatorDependencies) {
    if (!Number.isInteger(dependencies.maxOutputBytes ?? 16_384) || (dependencies.maxOutputBytes ?? 16_384) < 1) {
      throw new Error("maxOutputBytes must be a positive integer");
    }
    this.#commandExecutor = dependencies.commandExecutor;
    this.#workspace = dependencies.workspace;
    this.#logDirectory = dependencies.logDirectory;
    this.#maxOutputBytes = dependencies.maxOutputBytes ?? 16_384;
  }

  async calibrate(spec: RunSpec, signal?: AbortSignal): Promise<Evaluation> {
    const samples: Record<string, number[]> = Object.fromEntries(spec.metrics.map((metric) => [metric.name, []]));
    const logs: EvaluationLog[] = [];
    const required = requiredMetricNames(spec, true);
    for (let index = 0; index < spec.baseline.samples; index += 1) {
      const attempt = await this.#sample(spec, spec.targetRepository, `baseline-${index + 1}`, logs, required, signal);
      if (!attempt.metrics) {
        const successful = samples[spec.primaryMetric]!.length;
        const reason = successful === 0
          ? `Baseline produced zero successful baseline samples: ${attempt.problem}`
          : `Baseline collected ${successful} of ${spec.baseline.samples} required samples: ${attempt.problem}`;
        return this.#evaluation(`baseline:${spec.runId}`, samples, [
          { name: "evaluator", status: "failed", detail: attempt.problem },
        ], true, true, false, false, reason, logs);
      }
      this.#appendSample(samples, attempt.metrics);
    }
    const guards = metricGuardResults(spec, samples);
    const failed = firstFailedGuard(guards);
    return this.#evaluation(
      `baseline:${spec.runId}`,
      samples,
      [{ name: "evaluator", status: "passed" }, ...guards],
      true,
      true,
      false,
      !failed,
      failed ? `Baseline violates ${failed.name}: ${failed.detail ?? "guard failed"}` : "baseline calibrated",
      logs,
    );
  }

  async evaluate(
    spec: RunSpec,
    candidate: NodeRecord,
    parent: NodeRecord,
    promotionGate: PromotionGate,
    signal?: AbortSignal,
  ): Promise<Evaluation> {
    if (!this.#workspace) throw new Error("Evaluator requires a Git workspace to evaluate a candidate");
    const logs: EvaluationLog[] = [];
    const candidateWorktree = await this.#workspace.materialise(this.#evaluationAssignment(candidate, "candidate"), candidate);
    let parentWorktree: WorktreeHandle | undefined;
    try {
      parentWorktree = await this.#workspace.materialise(this.#evaluationAssignment(parent, `parent-${candidate.id}`), parent);
      const diff = await this.#inspectDiff(spec, candidate, parent, candidateWorktree.path, signal);
      const protectedVerifier = new ProtectedTreeVerifier();
      const parentProtected = await protectedVerifier.snapshot(parentWorktree.path, spec.protectedPaths);
      const candidateProtected = await protectedVerifier.snapshot(candidateWorktree.path, spec.protectedPaths);
      const before = await protectedVerifier.compare(parentWorktree.path, candidateWorktree.path, spec.protectedPaths);
      const guards: GuardResult[] = [
        {
          name: "scope",
          status: diff.valid ? "passed" : "failed",
          ...(diff.detail ? { detail: diff.detail } : {}),
        },
        {
          name: "protected paths",
          status: before.intact ? "passed" : "failed",
          ...(before.detail ? { detail: before.detail } : {}),
        },
        { name: "worktree identity", status: "passed" },
      ];
      const samples: Record<string, number[]> = {};
      let protectedPathsIntact = before.intact;
      if (!diff.valid || !before.intact) {
        return this.#failedEvaluation(candidate.id, samples, guards, protectedPathsIntact, diff.valid, logs);
      }

      const verifyWorktrees = () => this.#verifyCommandTrees([
        { worktree: candidateWorktree, node: candidate, protectedSnapshot: candidateProtected },
        { worktree: parentWorktree!, node: parent, protectedSnapshot: parentProtected },
      ], protectedVerifier, spec.protectedPaths, signal);
      const initial = await this.#sample(
        spec,
        candidateWorktree.path,
        "evaluator",
        logs,
        requiredMetricNames(spec),
        signal,
        verifyWorktrees,
      );
      protectedPathsIntact = this.#applyCommandVerification(guards, initial.verification, protectedPathsIntact);
      if (!initial.metrics) {
        if (!initial.verification || (initial.verification.worktree.intact && initial.verification.protectedTree.intact)) {
          guards.push({ name: "evaluator", status: "failed", detail: initial.problem });
        }
        return this.#failedEvaluation(candidate.id, samples, guards, protectedPathsIntact, true, logs);
      }
      this.#appendSample(samples, initial.metrics);
      guards.push({ name: "evaluator", status: "passed" });

      for (const guard of spec.guards) {
        if (guard.type !== "command") continue;
        const beforeCommand = await verifyWorktrees();
        protectedPathsIntact = this.#applyCommandVerification(guards, beforeCommand, protectedPathsIntact);
        if (!beforeCommand.worktree.intact || !beforeCommand.protectedTree.intact) {
          return this.#failedEvaluation(candidate.id, samples, guards, protectedPathsIntact, true, logs);
        }
        const attempt = await this.#runCommand(spec, guard.command, candidateWorktree.path, `guard-${guard.name}`, signal);
        logs.push(attempt.log);
        const verification = await verifyWorktrees();
        protectedPathsIntact = this.#applyCommandVerification(guards, verification, protectedPathsIntact);
        if (!verification.worktree.intact || !verification.protectedTree.intact) {
          return this.#failedEvaluation(candidate.id, samples, guards, protectedPathsIntact, true, logs);
        }
        const detail = this.#commandProblem(attempt.result);
        guards.push({
          name: guard.name,
          status: detail ? "failed" : "passed",
          ...(detail ? { detail } : {}),
        });
        if (detail) return this.#failedEvaluation(candidate.id, samples, guards, protectedPathsIntact, true, logs);
      }
      if (diff.changedLines === Number.POSITIVE_INFINITY) {
        guards.push({ name: "changed lines", status: "failed", detail: "Candidate diff contains binary changes" });
      } else {
        for (const guard of spec.guards) {
          if (guard.type !== "changed-lines") continue;
          guards.push(diff.changedLines <= guard.maximum
            ? { name: "changed lines", status: "passed" }
            : { name: "changed lines", status: "failed", detail: `${diff.changedLines} changed lines exceeds ${guard.maximum}` });
        }
      }
      this.#refreshMetricGuards(spec, samples, guards);
      const failed = firstFailedGuard(guards);
      if (failed) return this.#failedEvaluation(candidate.id, samples, guards, protectedPathsIntact, true, logs);

      const initialEvaluation = this.#evaluation(
        candidate.id,
        samples,
        guards,
        protectedPathsIntact,
        true,
        false,
        false,
        "initial trusted evaluation completed",
        logs,
      );
      const promotionRole = promotionGate({ candidate, initialEvaluation });
      if (!promotionRole) {
        return this.#evaluation(candidate.id, samples, guards, protectedPathsIntact, true, false, false,
          "frontier did not identify the candidate as a would-be promotion", logs);
      }
      if (!this.#isPromotionRole(promotionRole)) {
        throw new Error(`Promotion gate returned an unknown frontier role: ${String(promotionRole)}`);
      }

      const confirmation: ConfirmationEvidence = {
        parentNodeId: parent.id,
        promotionRole,
        pairedSamples: [],
        outcome: "exhausted",
      };
      while (samples[spec.primaryMetric]!.length < spec.confirmation.maxSamples) {
        const parentAttempt = await this.#sample(
          spec,
          parentWorktree.path,
          "confirmation-parent",
          logs,
          requiredMetricNames(spec),
          signal,
          verifyWorktrees,
        );
        protectedPathsIntact = this.#applyCommandVerification(guards, parentAttempt.verification, protectedPathsIntact);
        if (!parentAttempt.metrics) {
          confirmation.outcome = "failed";
          if (!parentAttempt.verification || (parentAttempt.verification.worktree.intact && parentAttempt.verification.protectedTree.intact)) {
            guards.push({ name: "confirmation parent", status: "failed", detail: parentAttempt.problem });
          }
          return this.#failedEvaluation(candidate.id, samples, guards, protectedPathsIntact, true, logs, confirmation);
        }
        const candidateAttempt = await this.#sample(
          spec,
          candidateWorktree.path,
          "confirmation-candidate",
          logs,
          requiredMetricNames(spec),
          signal,
          verifyWorktrees,
        );
        protectedPathsIntact = this.#applyCommandVerification(guards, candidateAttempt.verification, protectedPathsIntact);
        if (!candidateAttempt.metrics) {
          confirmation.outcome = "failed";
          if (!candidateAttempt.verification || (candidateAttempt.verification.worktree.intact && candidateAttempt.verification.protectedTree.intact)) {
            guards.push({ name: "confirmation candidate", status: "failed", detail: candidateAttempt.problem });
          }
          return this.#failedEvaluation(candidate.id, samples, guards, protectedPathsIntact, true, logs, confirmation);
        }
        this.#appendSample(samples, candidateAttempt.metrics);
        confirmation.pairedSamples = [
          ...confirmation.pairedSamples,
          { parent: parentAttempt.metrics, candidate: candidateAttempt.metrics },
        ];
        this.#refreshMetricGuards(spec, samples, guards);
        const metricFailure = firstFailedGuard(guards);
        if (metricFailure) {
          confirmation.outcome = "failed";
          return this.#failedEvaluation(candidate.id, samples, guards, protectedPathsIntact, true, logs, confirmation);
        }
        const decision = robustPairedDecision(
          confirmation.pairedSamples,
          spec.primaryMetric,
          metricDirection(spec),
          spec.confirmation.confidenceMultiplier,
        );
        if (decision === "confirmed") {
          confirmation.outcome = "confirmed";
          return this.#evaluation(candidate.id, samples, guards, protectedPathsIntact, true, true, true,
            "candidate improvement confirmed", logs, confirmation);
        }
        if (decision === "rejected") {
          confirmation.outcome = "rejected";
          return this.#evaluation(candidate.id, samples, guards, protectedPathsIntact, true, true, false,
            "candidate improvement rejected by confirmation", logs, confirmation);
        }
      }
      return this.#evaluation(candidate.id, samples, guards, protectedPathsIntact, true, true, false,
        "confirmation sample cap reached", logs, confirmation);
    } finally {
      if (parentWorktree) await this.#workspace.remove(parentWorktree);
      await this.#workspace.remove(candidateWorktree);
    }
  }

  #isPromotionRole(value: unknown): value is FrontierRole {
    return value === "BEST" || value === "LEAN" || value === "DIVERSE";
  }

  async #verifyCommandTrees(
    entries: readonly { worktree: WorktreeHandle; node: NodeRecord; protectedSnapshot: ReadonlyMap<string, string> }[],
    protectedVerifier: ProtectedTreeVerifier,
    protectedPaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<CommandVerification> {
    const checks = await Promise.all(entries.map((entry) => this.#verifyCommandTree(
      entry.worktree,
      entry.node,
      protectedVerifier,
      entry.protectedSnapshot,
      protectedPaths,
      signal,
    )));
    return checks.find((check) => !check.worktree.intact || !check.protectedTree.intact) ?? checks[0]!;
  }

  async #verifyCommandTree(
    worktree: WorktreeHandle,
    node: NodeRecord,
    protectedVerifier: ProtectedTreeVerifier,
    protectedSnapshot: ReadonlyMap<string, string>,
    protectedPaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<CommandVerification> {
    const [worktreeIntegrity, protectedTree] = await Promise.all([
      this.#verifyWorktreeImmutable(worktree, node, signal).catch((error) => ({
        intact: false,
        detail: `worktree identity cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
      })),
      protectedVerifier.unchanged(worktree.path, protectedSnapshot, protectedPaths).catch((error) => ({
        intact: false,
        detail: `protected paths cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
      })),
    ]);
    return { worktree: worktreeIntegrity, protectedTree };
  }

  async #verifyWorktreeImmutable(
    worktree: WorktreeHandle,
    node: NodeRecord,
    signal?: AbortSignal,
  ): Promise<WorktreeIntegrity> {
    if (worktree.gitMetadata !== undefined) {
      try {
        const marker = resolve(worktree.path, ".git");
        const stat = await lstat(marker);
        if (!stat.isFile() || stat.isSymbolicLink() || await readFile(marker, "utf8") !== worktree.gitMetadata) {
          return { intact: false, detail: "linked worktree Git marker changed after materialisation" };
        }
      } catch (error) {
        return {
          intact: false,
          detail: `linked worktree Git marker cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const metadata = await this.#workspace!.verifyGitMetadata(worktree);
    if (!metadata.intact) return { intact: false, detail: metadata.detail ?? "linked worktree Git metadata changed" };

    const head = await this.#runIntegrityCommand(worktree.path, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
    const headProblem = this.#commandProblem(head);
    if (headProblem) return { intact: false, detail: `could not verify immutable commit: ${headProblem}` };
    if (head.stdout.trim() !== node.commit) {
      return { intact: false, detail: `worktree commit changed from ${node.commit} to ${head.stdout.trim()}` };
    }
    const status = await this.#runIntegrityCommand(
      worktree.path,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
      signal,
    );
    const statusProblem = this.#commandProblem(status);
    if (statusProblem) return { intact: false, detail: `could not verify worktree status: ${statusProblem}` };
    if (status.stdout !== "") return { intact: false, detail: "worktree has tracked or untracked changes" };
    return { intact: true };
  }

  async #runIntegrityCommand(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<ProcessResult> {
    try {
      return await this.#commandExecutor.run({ command: "git", args, cwd, timeoutMs: 5_000 }, signal);
    } catch (error) {
      return {
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: 0,
        timedOut: false,
        cancelled: false,
      };
    }
  }

  #applyCommandVerification(
    guards: GuardResult[],
    verification: CommandVerification | undefined,
    protectedPathsIntact: boolean,
  ): boolean {
    if (!verification) return protectedPathsIntact;
    if (!verification.protectedTree.intact) {
      this.#replaceGuard(guards, "protected paths", {
        name: "protected paths",
        status: "failed",
        detail: verification.protectedTree.detail,
      });
    }
    if (!verification.worktree.intact) {
      this.#replaceGuard(guards, "worktree identity", {
        name: "worktree identity",
        status: "failed",
        detail: verification.worktree.detail,
      });
    }
    return protectedPathsIntact && verification.protectedTree.intact;
  }

  #refreshMetricGuards(spec: RunSpec, samples: Record<string, number[]>, guards: GuardResult[]): void {
    const metricGuardNames = new Set<string>();
    for (const metric of spec.metrics) if (metric.guard) metricGuardNames.add(`metric ${metric.name}`);
    for (const guard of spec.guards) if (guard.type === "metric") metricGuardNames.add(`metric ${guard.metric}`);
    for (let index = guards.length - 1; index >= 0; index -= 1) {
      if (metricGuardNames.has(guards[index]!.name)) guards.splice(index, 1);
    }
    guards.push(...metricGuardResults(spec, samples, true));
  }

  #evaluationAssignment(node: NodeRecord, role: string) {
    return {
      experimentId: `evaluation-${role}-${node.id}`,
      operator: "mutation" as const,
      primaryParentId: node.id,
      hypothesis: "Trusted controller evaluation.",
      policyVersion: node.policyVersion,
    };
  }

  async #inspectDiff(
    spec: RunSpec,
    candidate: NodeRecord,
    parent: NodeRecord,
    candidatePath: string,
    signal?: AbortSignal,
  ): Promise<DiffInspection> {
    const status = await this.#commandExecutor.run({
      command: "git",
      args: ["diff", "--name-status", "-z", "--find-renames", parent.commit, candidate.commit],
      cwd: spec.targetRepository,
      timeoutMs: 5_000,
    }, signal).catch((error) => ({
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: 0,
      timedOut: false,
      cancelled: false,
    }));
    if (status.exitCode !== 0 || status.timedOut || status.cancelled) {
      return { valid: false, changedLines: 0, detail: `Could not inspect candidate diff: ${this.#commandProblem(status)}` };
    }
    const paths = this.#diffPaths(status.stdout);
    const confinement = new WorkerConfinement({
      worktree: candidatePath,
      editableGlobs: spec.editableGlobs,
      protectedPaths: spec.protectedPaths,
    });
    const invalid: string[] = [];
    for (const path of paths) {
      try {
        await confinement.mutablePath(path);
      } catch (error) {
        invalid.push(`${path} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    const numstat = await this.#commandExecutor.run({
      command: "git",
      args: ["diff", "--numstat", parent.commit, candidate.commit],
      cwd: spec.targetRepository,
      timeoutMs: 5_000,
    }, signal).catch((error) => ({
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: 0,
      timedOut: false,
      cancelled: false,
    }));
    if (numstat.exitCode !== 0 || numstat.timedOut || numstat.cancelled) {
      return { valid: false, changedLines: 0, detail: `Could not count candidate diff: ${this.#commandProblem(numstat)}` };
    }
    const changedLines = this.#changedLines(numstat.stdout);
    return invalid.length > 0
      ? { valid: false, changedLines, detail: `Candidate diff violates scope: ${invalid.join("; ")}` }
      : { valid: true, changedLines };
  }

  #diffPaths(output: string): string[] {
    const fields = output.split("\0");
    const paths: string[] = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++];
      if (!status) continue;
      const kind = status[0];
      const names = kind === "R" || kind === "C" ? 2 : 1;
      for (let count = 0; count < names; count += 1) {
        const path = fields[index++];
        if (path) paths.push(path);
      }
    }
    return [...new Set(paths)].sort();
  }

  #changedLines(output: string): number {
    let total = 0;
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [added, deleted] = line.split("\t");
      if (added === "-" || deleted === "-") return Number.POSITIVE_INFINITY;
      total += Number.parseInt(added ?? "", 10) || 0;
      total += Number.parseInt(deleted ?? "", 10) || 0;
    }
    return total;
  }

  async #sample(
    spec: RunSpec,
    cwd: string,
    label: string,
    logs: EvaluationLog[],
    required: ReadonlySet<string>,
    signal?: AbortSignal,
    verifyCommandTree?: () => Promise<CommandVerification>,
  ): Promise<MetricAttempt> {
    const beforeCommand = await verifyCommandTree?.();
    if (beforeCommand && (!beforeCommand.worktree.intact || !beforeCommand.protectedTree.intact)) {
      return {
        problem: beforeCommand.worktree.detail ?? beforeCommand.protectedTree.detail ?? "worktree changed before evaluator command",
        verification: beforeCommand,
      };
    }
    const attempt = await this.#runCommand(spec, spec.evaluator, cwd, label, signal);
    logs.push(attempt.log);
    const verification = await verifyCommandTree?.();
    if (verification && (!verification.worktree.intact || !verification.protectedTree.intact)) {
      return {
        problem: verification.worktree.detail ?? verification.protectedTree.detail ?? "worktree changed during evaluator command",
        verification,
      };
    }
    const commandProblem = this.#commandProblem(attempt.result);
    if (commandProblem) return { problem: `Evaluator command ${commandProblem}`, verification };
    try {
      const metrics = parseMetricOutput(attempt.result.stdout, new Set(spec.metrics.map((metric) => metric.name)));
      for (const name of required) {
        if (metrics[name] === undefined) {
          return { problem: `Configured metric "${name}" is missing from evaluator output`, verification };
        }
      }
      return { metrics, verification };
    } catch (error) {
      const detail = error instanceof MetricParseError ? error.message : String(error);
      return { problem: `Evaluator output is invalid: ${detail}`, verification };
    }
  }

  async #runCommand(
    spec: RunSpec,
    command: CommandSpec,
    cwd: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<CommandAttempt> {
    let result: ProcessResult;
    try {
      result = await this.#commandExecutor.run({
        command: "/bin/sh",
        args: ["-c", command.command],
        cwd,
        env: command.env,
        timeoutMs: command.timeoutMs,
      }, signal);
    } catch (error) {
      result = {
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: 0,
        timedOut: false,
        cancelled: false,
      };
    }
    return { result, log: await this.#captureLog(spec, label, result) };
  }

  async #captureLog(spec: RunSpec, label: string, result: ProcessResult): Promise<EvaluationLog> {
    const runDirectory = resolve(spec.targetRepository, LOCAL_RUN_DIRECTORY);
    const directory = resolve(this.#logDirectory ?? resolve(runDirectory, "logs"));
    const relativeDirectory = relative(runDirectory, directory);
    if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${sep}`)) {
      throw new Error("Evaluator logs must remain inside the local run directory");
    }
    await mkdir(directory, { recursive: true });
    const safeLabel = label.replaceAll(/[^A-Za-z0-9._-]/g, "-");
    const fullLogPath = resolve(directory, `${String(++this.#logSequence).padStart(4, "0")}-${safeLabel}-${randomUUID()}.log`);
    await writeFile(fullLogPath, [
      `label: ${label}`,
      `exit code: ${String(result.exitCode)}`,
      `duration ms: ${result.durationMs}`,
      `timed out: ${result.timedOut}`,
      `cancelled: ${result.cancelled}`,
      "",
      "stdout:",
      result.stdout,
      "",
      "stderr:",
      result.stderr,
    ].join("\n"));
    const stdout = boundedOutput(result.stdout, this.#maxOutputBytes, fullLogPath);
    const stderr = boundedOutput(result.stderr, this.#maxOutputBytes, fullLogPath);
    return {
      label,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      fullLogPath,
    };
  }

  #commandProblem(result: ProcessResult): string | undefined {
    if (result.timedOut) return "timed out";
    if (result.cancelled) return "was cancelled";
    if (result.exitCode !== 0) return `failed with exit code ${String(result.exitCode)}`;
    return undefined;
  }

  #appendSample(target: Record<string, number[]>, sample: Readonly<Record<string, number>>): void {
    for (const [name, value] of Object.entries(sample)) (target[name] ??= []).push(value);
  }

  #replaceGuard(guards: GuardResult[], name: string, replacement: GuardResult): void {
    const index = guards.findIndex((guard) => guard.name === name);
    if (index === -1) guards.push(replacement);
    else guards[index] = replacement;
  }

  #failedEvaluation(
    nodeId: string,
    samples: Record<string, number[]>,
    guards: GuardResult[],
    protectedPathsIntact: boolean,
    scopeValid: boolean,
    logs: EvaluationLog[],
    confirmation?: ConfirmationEvidence,
  ): Evaluation {
    const failed = firstFailedGuard(guards)!;
    const reason = failed.name === "scope"
      ? "Candidate diff is outside the editable scope"
      : failed.name === "protected paths"
        ? "Protected paths changed"
        : failed.name === "evaluator"
          ? failed.detail ?? "Evaluator command failed"
          : `Guard "${failed.name}" failed${failed.detail ? `: ${failed.detail}` : ""}`;
    return this.#evaluation(
      nodeId,
      samples,
      guards,
      protectedPathsIntact,
      scopeValid,
      confirmation !== undefined,
      false,
      reason,
      logs,
      confirmation,
    );
  }

  #evaluation(
    nodeId: string,
    samples: Record<string, number[]>,
    guards: readonly GuardResult[],
    protectedPathsIntact: boolean,
    scopeValid: boolean,
    confirmationAttempted: boolean,
    confirmed: boolean,
    reason: string,
    logs: readonly EvaluationLog[],
    confirmation?: ConfirmationEvidence,
  ): Evaluation {
    return {
      nodeId,
      samples,
      summaries: summaries(samples),
      guards,
      protectedPathsIntact,
      scopeValid,
      confirmationAttempted,
      confirmed,
      reason,
      evidence: {
        logs,
        ...(confirmation ? { confirmation } : {}),
      },
    };
  }
}
