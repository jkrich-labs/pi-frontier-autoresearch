import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import {
  CandidateCreator,
  GitWorkspaceAdapter,
  PiWorkerAdapter,
  WorkerConfinement,
  createWorkerGuardConfig,
  parseCandidateSubmission,
  type Assignment,
  type NodeRecord,
  type ProcessGroupIdentity,
  type RunSpec,
} from "../src/index.ts";
import workerGuard from "../extensions/pi-frontier-autoresearch/worker-guard.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function makeRepository(): Promise<{ root: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "frontier-worker-repo-"));
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@example.test");
  await writeFile(join(root, "source.txt"), "before\n");
  await writeFile(join(root, "protected.txt"), "fixed\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "baseline");
  return { root, head: await git(root, "rev-parse", "HEAD") };
}

function runSpec(root: string): RunSpec {
  return {
    schemaVersion: 1,
    runId: "fixture-run",
    targetRepository: root,
    objective: "Improve the fixture",
    primaryMetric: "score",
    metrics: [{ name: "score", direction: "higher" }],
    evaluator: { command: "./evaluate", timeoutMs: 1_000 },
    editableGlobs: ["source.txt", "src/**"],
    protectedPaths: ["protected.txt", "evaluate"],
    probes: [{ name: "syntax", description: "Check syntax", command: "true", timeoutMs: 1_000 }],
    guards: [],
    budget: { maxExperiments: 1 },
    baseline: { samples: 1 },
    confirmation: { maxSamples: 1, confidenceMultiplier: 1 },
    frontierPolicy: {
      size: 4,
      leanPrimaryTolerance: 0.1,
      diversePrimaryTolerance: 0.1,
      diverseNoveltyThreshold: 0.1,
      crossoverCadence: 2,
    },
  };
}

function parentNode(head: string): NodeRecord {
  return {
    id: "parent",
    commit: head,
    ref: "refs/pi-frontier-autoresearch/fixture-run/nodes/parent",
    parentIds: [],
    operator: "baseline",
    hypothesis: "baseline",
    reflection: "baseline",
    diffSummary: { changedFiles: [], changedLines: 0 },
    metricSamples: {},
    guardResults: [],
    outcome: "promoted",
    policyVersion: 1,
    createdEventIndex: 0,
    selection: { attempts: 0, promotions: 0 },
  };
}

const assignment: Assignment = {
  experimentId: "candidate-1",
  operator: "mutation",
  primaryParentId: "parent",
  hypothesis: "Change the fixture",
  policyVersion: 1,
};

test("candidate worker runs isolated and preserves the main worktree", async (t) => {
  const repository = await makeRepository();
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "frontier-success-pi-"));
  t.after(() => Promise.all([
    rm(repository.root, { recursive: true, force: true }),
    rm(fixtureDirectory, { recursive: true, force: true }),
  ]));
  const fixture = join(fixtureDirectory, "pi.mjs");
  const invocation = join(fixtureDirectory, "invocation.json");
  await writeFile(
    fixture,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(process.env.PI_FRONTIER_WORKER_CONFIG, "utf8"));
fs.writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({ args, config }));
fs.writeFileSync(path.join(process.cwd(), "source.txt"), "after\\n");
console.log("diagnostic-".repeat(40));
console.log(JSON.stringify({ type: "tool_result_end", message: { toolName: "candidate_submit", details: { hypothesis: "Change the fixture", change: "Updated source.txt", expectedEffect: "A better score", reflection: "Try a second value next" } } }));
`,
  );
  await chmod(fixture, 0o755);

  const workspace = new GitWorkspaceAdapter({ repository: repository.root, runId: "fixture-run" });
  const previousModel = process.env.PI_MODEL;
  const previousReasoning = process.env.PI_REASONING_LEVEL;
  process.env.PI_MODEL = "fixture/model";
  process.env.PI_REASONING_LEVEL = "high";
  const worker = new PiWorkerAdapter({ executable: fixture, timeoutMs: 2_000, maxOutputBytes: 300 });
  if (previousModel === undefined) delete process.env.PI_MODEL;
  else process.env.PI_MODEL = previousModel;
  if (previousReasoning === undefined) delete process.env.PI_REASONING_LEVEL;
  else process.env.PI_REASONING_LEVEL = previousReasoning;
  const creator = new CandidateCreator(workspace, worker);
  let reportedProcess: ProcessGroupIdentity | undefined;
  const result = await creator.create({
    spec: runSpec(repository.root),
    assignment,
    parent: parentNode(repository.head),
    onProcessGroup: (identity) => { reportedProcess = identity; },
  });

  assert.equal(result.node.outcome, "pending");
  assert.match(result.worker.stdout, /Output truncated:.*Full output:/);
  assert.deepEqual(result.worker.process, reportedProcess);
  assert.ok(reportedProcess && reportedProcess.processGroupId > 0 && reportedProcess.leaderPid > 0);
  assert.match(reportedProcess?.leaderStartIdentity ?? "", /^(linux:|darwin-token:)/);
  assert.equal(result.node.ref, "refs/pi-frontier-autoresearch/fixture-run/nodes/candidate-1");
  assert.equal(await git(repository.root, "rev-parse", result.node.ref), result.node.commit);
  assert.match(await git(repository.root, "rev-parse", workspace.recordRef(result.node.id)), /^[0-9a-f]{40,64}$/);
  assert.deepEqual(await workspace.readNodeRecord(result.node.id), result.node);
  assert.equal(await git(repository.root, "rev-parse", "HEAD"), repository.head);
  assert.equal(await readFile(join(repository.root, "source.txt"), "utf8"), "before\n");
  assert.equal(await readFile(join(repository.root, "protected.txt"), "utf8"), "fixed\n");
  assert.equal(await git(repository.root, "status", "--porcelain"), "");

  const recorded = JSON.parse(await readFile(invocation, "utf8")) as { args: string[]; config: unknown };
  for (const flag of [
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
    "--no-builtin-tools",
  ]) {
    assert.ok(recorded.args.includes(flag), `missing worker isolation flag ${flag}`);
  }
  assert.deepEqual(recorded.args.filter((arg) => arg === "--extension").length, 1);
  assert.deepEqual(recorded.args.filter((arg) => arg === "--skill").length, 1);
  assert.equal(recorded.args[recorded.args.indexOf("--model") + 1], "fixture/model");
  assert.equal(recorded.args[recorded.args.indexOf("--thinking") + 1], "high");
  const tools = recorded.args[recorded.args.indexOf("--tools") + 1].split(",");
  assert.ok(!tools.includes("bash"));
  assert.deepEqual(await workspace.listWorktrees(), []);
});

test("controller rejects a bypassed worker's prohibited diff before committing it", async (t) => {
  const repository = await makeRepository();
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "frontier-bypass-pi-"));
  t.after(() => Promise.all([
    rm(repository.root, { recursive: true, force: true }),
    rm(fixtureDirectory, { recursive: true, force: true }),
  ]));
  const fixture = join(fixtureDirectory, "pi.mjs");
  await writeFile(fixture, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
fs.writeFileSync(path.join(process.cwd(), "protected.txt"), "bypassed\\n");
fs.writeFileSync(path.join(process.cwd(), "outside.txt"), "bypassed\\n");
fs.mkdirSync(path.join(process.cwd(), ".pi-frontier-autoresearch"), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), ".pi-frontier-autoresearch", "state"), "bypassed\\n");
fs.writeFileSync(path.join(process.cwd(), ".git"), "bypassed\\n");
console.log(JSON.stringify({ type: "tool_result_end", message: { toolName: "candidate_submit", details: { hypothesis: "bypass", change: "protected", expectedEffect: "none", reflection: "rejected" } } }));
`);
  await chmod(fixture, 0o755);

  const workspace = new GitWorkspaceAdapter({ repository: repository.root, runId: "fixture-run" });
  const result = await new CandidateCreator(
    workspace,
    new PiWorkerAdapter({ executable: fixture, timeoutMs: 2_000 }),
  ).create({ spec: runSpec(repository.root), assignment: { ...assignment, experimentId: "bypass" }, parent: parentNode(repository.head) });

  assert.equal(result.node.outcome, "failed");
  assert.match(result.reason ?? "", /\.git \(Git metadata is protected/);
  assert.match(result.reason ?? "", /\.pi-frontier-autoresearch.*Run state is protected/);
  assert.match(result.reason ?? "", /outside\.txt.*outside the editable scope/);
  assert.match(result.reason ?? "", /protected\.txt.*Protected path cannot be changed/);
  assert.equal(await git(repository.root, "show", `${result.node.commit}:protected.txt`), "fixed");
  assert.deepEqual(await workspace.readNodeRecord("bypass"), result.node);
  assert.deepEqual(await workspace.listWorktrees(), []);
});

test("controller detects linked-worktree Git metadata mutation and rematerialises a durable failure", async (t) => {
  const repository = await makeRepository();
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "frontier-gitdir-bypass-pi-"));
  const mutatedGitDirectoryRecord = join(fixtureDirectory, "gitdir.txt");
  t.after(() => Promise.all([
    rm(repository.root, { recursive: true, force: true }),
    rm(fixtureDirectory, { recursive: true, force: true }),
  ]));
  const fixture = join(fixtureDirectory, "pi.mjs");
  await writeFile(fixture, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const marker = fs.readFileSync(path.join(process.cwd(), ".git"), "utf8").trim();
const gitDirectory = path.resolve(process.cwd(), marker.slice("gitdir: ".length));
fs.writeFileSync(${JSON.stringify(mutatedGitDirectoryRecord)}, gitDirectory);
fs.writeFileSync(path.join(gitDirectory, "HEAD"), "corrupted-by-worker\\n");
fs.writeFileSync(path.join(process.cwd(), "source.txt"), "must not survive\\n");
console.log(JSON.stringify({ type: "tool_result_end", message: { toolName: "candidate_submit", details: { hypothesis: "bypass", change: "gitdir", expectedEffect: "none", reflection: "rejected" } } }));
`);
  await chmod(fixture, 0o755);

  const workspace = new GitWorkspaceAdapter({ repository: repository.root, runId: "fixture-run" });
  const result = await new CandidateCreator(
    workspace,
    new PiWorkerAdapter({ executable: fixture, timeoutMs: 2_000 }),
  ).create({
    spec: runSpec(repository.root),
    assignment: { ...assignment, experimentId: "gitdir-bypass" },
    parent: parentNode(repository.head),
  });

  assert.equal(result.node.outcome, "failed");
  assert.match(result.reason ?? "", /Git metadata integrity check failed/);
  assert.deepEqual(result.node.diffSummary, { changedFiles: [".git"], changedLines: 0 });
  assert.equal(await git(repository.root, "rev-parse", `${result.node.commit}^`), repository.head);
  assert.equal(await git(repository.root, "show", `${result.node.commit}:source.txt`), "before");
  assert.match(await git(repository.root, "show", "-s", "--format=%B", result.node.commit), /Outcome: failed/);
  assert.deepEqual(await workspace.readNodeRecord(result.node.id), result.node);
  const mutatedGitDirectory = await readFile(mutatedGitDirectoryRecord, "utf8");
  await assert.rejects(() => access(mutatedGitDirectory));
  assert.deepEqual(await workspace.listWorktrees(), []);
  assert.equal(await git(repository.root, "rev-parse", "HEAD"), repository.head);
  assert.equal(await readFile(join(repository.root, "source.txt"), "utf8"), "before\n");
  assert.equal(await git(repository.root, "status", "--porcelain"), "");
});

test("metadata recovery rejects a symlinked administrative ancestor without touching external state", async (t) => {
  const repository = await makeRepository();
  const external = await mkdtemp(join(tmpdir(), "frontier-external-gitdir-"));
  const workspace = new GitWorkspaceAdapter({ repository: repository.root, runId: "fixture-run" });
  const worktree = await workspace.materialise(assignment, parentNode(repository.head));
  const administrativeRoot = join(worktree.gitCommonDirectory!, "worktrees");
  const savedAdministrativeRoot = `${administrativeRoot}-saved`;
  const externalGitDirectory = join(external, worktree.experimentId);
  const sentinel = join(externalGitDirectory, "sentinel.txt");
  await mkdir(externalGitDirectory);
  await writeFile(sentinel, "external state\n");
  await rename(administrativeRoot, savedAdministrativeRoot);
  await symlink(external, administrativeRoot, "dir");

  t.after(async () => {
    await rm(administrativeRoot, { force: true });
    try {
      await rename(savedAdministrativeRoot, administrativeRoot);
      await workspace.remove(worktree);
    } catch {
      // The repository cleanup below is sufficient if an assertion interrupted restoration.
    }
    await Promise.all([
      rm(repository.root, { recursive: true, force: true }),
      rm(external, { recursive: true, force: true }),
    ]);
  });

  await assert.rejects(
    () => workspace.rematerialiseAfterMetadataFailure(
      worktree,
      assignment,
      parentNode(repository.head),
    ),
    /Refusing unsafe cleanup/,
  );
  assert.equal(await readFile(sentinel, "utf8"), "external state\n");
  assert.equal(await readFile(join(worktree.path, "source.txt"), "utf8"), "before\n");
});

test("porcelain -z parsing retains both sides of a rename", async (t) => {
  const repository = await makeRepository();
  t.after(() => rm(repository.root, { recursive: true, force: true }));
  const workspace = new GitWorkspaceAdapter({ repository: repository.root, runId: "fixture-run" });
  const worktree = await workspace.materialise(assignment, parentNode(repository.head));
  await mkdir(join(worktree.path, "src"));
  await git(worktree.path, "mv", "source.txt", "src/renamed.txt");
  assert.deepEqual((await workspace.inspectDiff(worktree)).files, ["source.txt", "src/renamed.txt"]);
  await workspace.remove(worktree);
});

test("worker confinement rejects escapes and allows scoped edits, moves, deletes, and probes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "frontier-confinement-"));
  const outside = await mkdtemp(join(tmpdir(), "frontier-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "safe.ts"), "safe\n");
  await writeFile(join(root, "protected.txt"), "fixed\n");
  await symlink(outside, join(root, "src", "escape"));

  const confinement = new WorkerConfinement({
    worktree: root,
    editableGlobs: ["src/**"],
    protectedPaths: ["src/protected.ts", "protected.txt"],
    runStatePaths: [".pi-frontier-autoresearch"],
    probes: [{ name: "syntax", description: "Syntax", command: "check", timeoutMs: 100 }],
  });

  assert.equal(await confinement.mutablePath("src/safe.ts"), join(root, "src", "safe.ts"));
  assert.equal(await confinement.assertSafeTree("src/safe.ts"), join(root, "src", "safe.ts"));
  assert.equal(await confinement.mutablePath("src/moved.ts"), join(root, "src", "moved.ts"));
  assert.equal(confinement.probe("syntax").command, "check");
  await writeFile(join(root, "src", "move.ts"), "move\n");
  const moveFrom = await confinement.assertSafeTree("src/move.ts");
  const moveTo = await confinement.mutablePath("src/moved.ts");
  await rename(moveFrom, moveTo);
  await rm(await confinement.assertSafeTree("src/moved.ts"));
  await assert.rejects(() => access(moveTo));

  for (const denied of [
    "other.ts",
    "protected.txt",
    "src/protected.ts",
    ".git/config",
    "src/.git/config",
    "src/.GIT/config",
    ".pi-frontier-autoresearch/events.jsonl",
    "../outside.ts",
    "src/../../outside.ts",
    join(outside, "absolute.ts"),
    "C:\\outside.ts",
    "src/escape/stolen.ts",
  ]) {
    await assert.rejects(() => confinement.mutablePath(denied), /.+/, denied);
  }
  assert.throws(() => confinement.probe("arbitrary"), /Probe is not allowed/);
});

test("registered worker-guard tools expose only the assigned donor and reject state mutations", async (t) => {
  const repository = await makeRepository();
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "frontier-guard-tools-"));

  await git(repository.root, "checkout", "-qb", "donor-fixture");
  await writeFile(join(repository.root, "source.txt"), "assigned donor idea\n");
  await git(repository.root, "commit", "-qam", "donor fixture");
  const donorCommit = await git(repository.root, "rev-parse", "HEAD");
  await git(repository.root, "checkout", "--detach", repository.head);

  const workspace = new GitWorkspaceAdapter({ repository: repository.root, runId: "fixture-run" });
  const crossoverAssignment: Assignment = {
    ...assignment,
    experimentId: "guard-crossover",
    operator: "crossover",
    donorParentId: "donor",
  };
  const donor = { ...parentNode(donorCommit), id: "donor", commit: donorCommit };
  const worktree = await workspace.materialise(crossoverAssignment, parentNode(repository.head), donor);
  t.after(async () => {
    await workspace.remove(worktree);
    await Promise.all([
      rm(repository.root, { recursive: true, force: true }),
      rm(fixtureDirectory, { recursive: true, force: true }),
    ]);
  });
  const controllerState = join(fixtureDirectory, "controller-state.json");
  await writeFile(controllerState, "controller-owned\n");
  const configPath = join(fixtureDirectory, "guard.json");
  await writeFile(configPath, JSON.stringify(createWorkerGuardConfig(
    runSpec(repository.root),
    crossoverAssignment,
    worktree,
  )));

  type RegisteredTool = {
    name: string;
    execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  };
  const tools = new Map<string, RegisteredTool>();
  const gitCalls: string[][] = [];
  const fakePi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    async exec(command: string, args: string[], options: { cwd: string }) {
      assert.equal(command, "git");
      gitCalls.push(args);
      try {
        const result = await execFileAsync(command, args, { cwd: options.cwd });
        return { code: 0, stdout: result.stdout, stderr: "", killed: false };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        return { code: 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", killed: false };
      }
    },
    on() {},
    setActiveTools() {},
  };
  const previousConfig = process.env.PI_FRONTIER_WORKER_CONFIG;
  process.env.PI_FRONTIER_WORKER_CONFIG = configPath;
  try {
    workerGuard(fakePi as never);
  } finally {
    if (previousConfig === undefined) delete process.env.PI_FRONTIER_WORKER_CONFIG;
    else process.env.PI_FRONTIER_WORKER_CONFIG = previousConfig;
  }

  const inspected = await tools.get("inspect_donor")!.execute("inspect", { path: "source.txt" }) as {
    content: Array<{ text: string }>;
  };
  assert.equal(inspected.content[0]?.text, "assigned donor idea\n");
  await assert.rejects(
    () => tools.get("inspect_donor")!.execute("inspect-other", { path: "../other-donor:source.txt" }),
    /Parent path escapes are not allowed/,
  );
  assert.deepEqual(gitCalls, [["show", `${donorCommit}:source.txt`]]);

  for (const [tool, params] of [
    ["write", { path: controllerState, content: "stolen\n" }],
    ["edit", { path: ".git/HEAD", edits: [{ oldText: "x", newText: "y" }] }],
    ["worker_delete", { path: worktree.gitDirectory! }],
    ["worker_move", { from: "source.txt", to: controllerState }],
  ] as const) {
    await assert.rejects(() => tools.get(tool)!.execute(`reject-${tool}`, params), /not allowed|protected/i, tool);
  }
  assert.equal(await readFile(controllerState, "utf8"), "controller-owned\n");
  assert.equal(await readFile(join(worktree.path, "source.txt"), "utf8"), "before\n");
  assert.equal(await git(repository.root, "show", `${donorCommit}:source.txt`), "assigned donor idea");
});

test("crossover worker inspects only its assigned immutable donor", async (t) => {
  const repository = await makeRepository();
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "frontier-crossover-pi-"));
  const controllerState = join(fixtureDirectory, "controller-state.json");
  t.after(() => Promise.all([
    rm(repository.root, { recursive: true, force: true }),
    rm(fixtureDirectory, { recursive: true, force: true }),
  ]));
  await writeFile(controllerState, "controller-owned\n");
  const fixture = join(fixtureDirectory, "pi.mjs");
  await writeFile(
    fixture,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const config = JSON.parse(fs.readFileSync(process.env.PI_FRONTIER_WORKER_CONFIG, "utf8"));
let donorIdea;
if (config.experimentId === "donor") {
  fs.writeFileSync(path.join(process.cwd(), "source.txt"), "donor idea\\n");
} else {
  if (!config.donorCommit) process.exit(9);
  const donor = execFileSync("git", ["show", config.donorCommit + ":source.txt"], { cwd: process.cwd(), encoding: "utf8" });
  if (donor !== "donor idea\\n") process.exit(10);
  fs.writeFileSync(path.join(process.cwd(), "source.txt"), "crossed donor idea\\n");
  donorIdea = "Transplant the donor text";
}
console.log(JSON.stringify({ type: "tool_result_end", message: { toolName: "candidate_submit", details: { hypothesis: "fixture", change: "source", expectedEffect: "effect", reflection: "reflection", ...(donorIdea ? { donorIdea } : {}) } } }));
`,
  );
  await chmod(fixture, 0o755);

  const workspace = new GitWorkspaceAdapter({ repository: repository.root, runId: "fixture-run" });
  const creator = new CandidateCreator(workspace, new PiWorkerAdapter({ executable: fixture, timeoutMs: 2_000 }));
  const spec = runSpec(repository.root);
  const parent = parentNode(repository.head);
  const donorResult = await creator.create({
    spec,
    assignment: { ...assignment, experimentId: "donor" },
    parent,
  });
  const donorCommit = donorResult.node.commit;
  const confinement = new WorkerConfinement({
    worktree: repository.root,
    editableGlobs: spec.editableGlobs,
    protectedPaths: spec.protectedPaths,
  });
  assert.equal(await confinement.donorPath("source.txt"), "source.txt");
  await assert.rejects(
    () => confinement.mutablePath(`.git/objects/${donorCommit}`),
    /Git metadata is protected/,
  );
  await assert.rejects(() => confinement.mutablePath(controllerState), /Absolute paths are not allowed/);

  const crossover = await creator.create({
    spec,
    assignment: {
      ...assignment,
      experimentId: "crossover",
      operator: "crossover",
      donorParentId: donorResult.node.id,
    },
    parent,
    donor: donorResult.node,
  });

  assert.equal(crossover.node.outcome, "pending");
  assert.deepEqual(crossover.node.parentIds, ["parent", "donor"]);
  assert.equal(crossover.submission?.donorIdea, "Transplant the donor text");
  assert.equal(await git(repository.root, "rev-parse", donorResult.node.ref), donorCommit);
  assert.equal(await git(repository.root, "show", `${donorCommit}:source.txt`), "donor idea");
  assert.equal(await readFile(controllerState, "utf8"), "controller-owned\n");
  assert.equal(await git(repository.root, "rev-parse", "HEAD"), repository.head);
  assert.equal(await readFile(join(repository.root, "source.txt"), "utf8"), "before\n");
});

test("worker failures, timeout, and cancellation leave durable failed candidate refs", async (t) => {
  const repository = await makeRepository();
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "frontier-failure-pi-"));
  t.after(() => Promise.all([
    rm(repository.root, { recursive: true, force: true }),
    rm(fixtureDirectory, { recursive: true, force: true }),
  ]));
  const fixture = join(fixtureDirectory, "pi.mjs");
  await writeFile(
    fixture,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const config = JSON.parse(fs.readFileSync(process.env.PI_FRONTIER_WORKER_CONFIG, "utf8"));
const id = config.experimentId;
if (id !== "empty") fs.writeFileSync(path.join(process.cwd(), "source.txt"), id + "\\n");
if (id === "cancel") {
  fs.mkdirSync(path.join(process.cwd(), "src"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "src", "started"), "yes\\n");
}
if (id === "crash") process.exit(7);
if (id === "missing") process.exit(0);
if (id === "timeout" || id === "cancel") setInterval(() => {}, 1000);
console.log(JSON.stringify({ type: "tool_result_end", message: { toolName: "candidate_submit", details: { hypothesis: id, change: id, expectedEffect: "effect", reflection: "reflection" } } }));
`,
  );
  await chmod(fixture, 0o755);

  const workspace = new GitWorkspaceAdapter({ repository: repository.root, runId: "fixture-run" });
  const parent = parentNode(repository.head);
  const create = (id: string, timeoutMs: number, signal?: AbortSignal) => new CandidateCreator(
    workspace,
    new PiWorkerAdapter({ executable: fixture, timeoutMs }),
  ).create({
    spec: runSpec(repository.root),
    assignment: { ...assignment, experimentId: id },
    parent,
    signal,
  });

  const results = [];
  results.push(await create("empty", 2_000));
  results.push(await create("missing", 2_000));
  results.push(await create("crash", 2_000));
  results.push(await create("timeout", 80));

  const cancellation = new AbortController();
  const cancelledPromise = create("cancel", 2_000, cancellation.signal);
  const started = join(repository.root, ".pi-frontier-autoresearch", "worktrees", "cancel", "src", "started");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(started);
      break;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  await access(started);
  cancellation.abort();
  results.push(await cancelledPromise);

  for (const result of results) {
    assert.equal(result.node.outcome, "failed", result.node.id);
    assert.equal(await git(repository.root, "rev-parse", result.node.ref), result.node.commit);
    assert.match(await git(repository.root, "show", "-s", "--format=%B", result.node.commit), /Outcome: failed/);
    assert.deepEqual(await workspace.readNodeRecord(result.node.id), result.node);
  }
  assert.match(results[0].reason ?? "", /empty diff/);
  assert.match(results[1].reason ?? "", /structured candidate submission/);
  assert.match(results[2].reason ?? "", /status 7/);
  assert.match(results[3].reason ?? "", /timed out/);
  assert.match(results[4].reason ?? "", /cancelled/);
  assert.equal(await git(repository.root, "rev-parse", "HEAD"), repository.head);
  assert.equal(await readFile(join(repository.root, "source.txt"), "utf8"), "before\n");
  assert.deepEqual(await workspace.listWorktrees(), []);
});

test("structured candidate submission validation rejects missing or empty fields", () => {
  assert.deepEqual(parseCandidateSubmission({
    hypothesis: "One idea",
    change: "One change",
    expectedEffect: "Lower cost",
    reflection: "Keep exploring",
  }), {
    hypothesis: "One idea",
    change: "One change",
    expectedEffect: "Lower cost",
    reflection: "Keep exploring",
  });
  assert.equal(parseCandidateSubmission({ hypothesis: "missing fields" }), undefined);
  assert.equal(parseCandidateSubmission({
    hypothesis: "One idea",
    change: " ",
    expectedEffect: "Lower cost",
    reflection: "Keep exploring",
  }), undefined);
});
