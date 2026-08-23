import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  Evaluator,
  FrontierController,
  GitWorkspaceAdapter,
  NodeProcessExecutor,
  type Evaluation,
  type FrontierEvent,
  type NodeRecord,
  type PromotionGate,
  type RunSpec,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

function node(id: string, commit: string, metricSamples: NodeRecord["metricSamples"], outcome: NodeRecord["outcome"] = "pending"): NodeRecord {
  return {
    id,
    commit,
    ref: `refs/pi-frontier-autoresearch/evaluator/${id}`,
    parentIds: id === "parent" ? [] : ["parent"],
    operator: id === "parent" ? "baseline" : "mutation",
    hypothesis: "fixture",
    reflection: "fixture",
    diffSummary: { changedFiles: id === "parent" ? [] : ["source.txt"], changedLines: id === "parent" ? 0 : 1 },
    metricSamples,
    guardResults: [],
    outcome,
    policyVersion: 1,
    createdEventIndex: 0,
    selection: { attempts: 0, promotions: 0 },
  };
}

const noPromotionGate: PromotionGate = () => undefined;

function trustedEvaluation(nodeId: string, score: number): Evaluation {
  return {
    nodeId,
    samples: { score: [score] },
    summaries: {
      score: { median: score, medianAbsoluteDeviation: 0, minimum: score, maximum: score },
    },
    guards: [{ name: "trusted", status: "passed" }],
    protectedPathsIntact: true,
    scopeValid: true,
    confirmationAttempted: false,
    confirmed: true,
    reason: "trusted fixture evaluation",
  };
}

function productionGate(
  fixture: { root: string; parent: NodeRecord; candidate: NodeRecord },
  options: { parentFiles: readonly string[]; parentLines: number; candidateFiles: readonly string[]; candidateLines: number },
): { parent: NodeRecord; candidate: NodeRecord; gate: PromotionGate } {
  const frontier = new FrontierController({
    primaryMetric: "score",
    primaryDirection: "lower",
    policy: spec(fixture.root).frontierPolicy,
  });
  const parent: NodeRecord = {
    ...fixture.parent,
    diffSummary: { changedFiles: options.parentFiles, changedLines: options.parentLines },
  };
  const policy = frontier.recordPolicy();
  const seeded = frontier.recordEvaluation([policy], {
    node: parent,
    evaluation: trustedEvaluation(parent.id, 100),
  });
  const beforeAssignment: FrontierEvent[] = [policy, seeded];
  const assignment = frontier.nextAssignment(beforeAssignment, { experimentId: `promotion-${fixture.candidate.id}` });
  assert.equal(assignment.assignment.operator, "mutation");
  assert.equal(assignment.assignment.primaryParentId, parent.id);
  const candidate: NodeRecord = {
    ...fixture.candidate,
    operator: assignment.assignment.operator,
    parentIds: [assignment.assignment.primaryParentId],
    diffSummary: { changedFiles: options.candidateFiles, changedLines: options.candidateLines },
  };
  assert.deepEqual(candidate.parentIds, [assignment.assignment.primaryParentId]);
  const history: FrontierEvent[] = [...beforeAssignment, assignment];
  return { parent, candidate, gate: frontier.createPromotionGate(history) };
}

function spec(root: string): RunSpec {
  return {
    schemaVersion: 1,
    runId: "evaluator",
    targetRepository: root,
    objective: "Reduce fixture score",
    primaryMetric: "score",
    metrics: [{ name: "score", direction: "lower" }],
    evaluator: { command: `${JSON.stringify(process.execPath)} evaluate.mjs`, timeoutMs: 1_000 },
    editableGlobs: ["source.txt"],
    protectedPaths: ["evaluate.mjs", "protected.txt"],
    probes: [],
    guards: [],
    budget: { maxExperiments: 4 },
    baseline: { samples: 3 },
    confirmation: { maxSamples: 3, confidenceMultiplier: 2 },
    frontierPolicy: {
      size: 4,
      leanPrimaryTolerance: 0.02,
      diversePrimaryTolerance: 0.05,
      diverseNoveltyThreshold: 0.3,
      crossoverCadence: 3,
    },
  };
}

async function repository(script: string): Promise<{ root: string; parent: NodeRecord; candidate: NodeRecord }> {
  const root = await mkdtemp(join(tmpdir(), "frontier-evaluator-"));
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@example.test");
  await writeFile(join(root, "source.txt"), "parent\n");
  await writeFile(join(root, "protected.txt"), "fixed\n");
  await writeFile(join(root, "evaluate.mjs"), script);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "parent");
  const parentCommit = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "source.txt"), "candidate\n");
  await git(root, "commit", "-am", "candidate");
  const candidateCommit = await git(root, "rev-parse", "HEAD");
  return {
    root,
    parent: node("parent", parentCommit, { score: [100, 100, 100] }, "promoted"),
    candidate: node("candidate", candidateCommit, { score: [999] }, "promoted"),
  };
}

test("evaluator rejects malformed structured metric output", async (t) => {
  const cases = [
    ["METRIC score=90\nMETRIC score=91", /duplicated/],
    ["METRIC undeclared=90", /not declared/],
    ["benchmark completed", /missing/],
    ["METRIC score=NaN", /finite/],
    ["METRIC score=Infinity", /finite/],
  ] as const;

  for (const [output, reason] of cases) {
    const fixture = await repository(`console.log(${JSON.stringify(output)});`);
    try {
      const evaluation = await new Evaluator({
        commandExecutor: new NodeProcessExecutor(),
        workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: "evaluator" }),
      }).evaluate(spec(fixture.root), fixture.candidate, fixture.parent, noPromotionGate);

      assert.equal(evaluation.confirmed, false);
      assert.equal(evaluation.guards.find((guard) => guard.name === "evaluator")?.status, "failed");
      assert.match(evaluation.reason, reason);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("evaluator runs ordinary candidates once and truncates captured output", async (t) => {
  const trace = join(tmpdir(), `frontier-evaluator-trace-${Date.now()}-${Math.random()}`);
  const fixture = await repository([
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const kind = readFileSync('source.txt', 'utf8').trim();",
    "appendFileSync(process.env.TRACE, `${kind}\\n`);",
    "console.log('diagnostic-'.repeat(100));",
    "console.log(`METRIC score=${kind === 'candidate' ? 90 : 80}`);",
  ].join("\n"));
  t.after(() => Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(trace, { force: true }),
  ]));

  const configured = spec(fixture.root);
  configured.evaluator = { ...configured.evaluator, env: { TRACE: trace } };
  const evaluation = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: "evaluator" }),
    maxOutputBytes: 80,
  }).evaluate(configured, fixture.candidate, { ...fixture.parent, metricSamples: { score: [80] } }, noPromotionGate);

  assert.equal(evaluation.confirmed, false);
  assert.equal(evaluation.confirmationAttempted, false);
  assert.equal(await readFile(trace, "utf8"), "candidate\n");
  assert.equal(evaluation.evidence?.logs.length, 1);
  assert.equal(evaluation.evidence?.logs[0]?.truncated, true);
  assert.match(evaluation.evidence?.logs[0]?.stdout ?? "", /Output truncated at 80 bytes\. Full output:/);
  assert.match(await readFile(evaluation.evidence!.logs[0]!.fullLogPath, "utf8"), /diagnostic-/);
});

test("evaluator confirms every real FrontierController would-be role and runs no-role candidates once", async (t) => {
  const trace = join(tmpdir(), `frontier-production-gate-${Date.now()}-${Math.random()}`);
  const script = [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const kind = readFileSync('source.txt', 'utf8').trim();",
    "appendFileSync(process.env.TRACE, `${process.env.CASE}:${kind}\\n`);",
    "console.log(`METRIC score=${kind === 'candidate' ? process.env.CANDIDATE_SCORE : 100}`);",
  ].join("\n");
  const cases = [
    { name: "best", score: 90, role: "BEST", confirmed: true, parentFiles: ["src/parent.ts"], parentLines: 10, candidateFiles: ["src/best.ts"], candidateLines: 1 },
    { name: "lean", score: 101, role: "LEAN", confirmed: false, parentFiles: ["src/parent.ts"], parentLines: 10, candidateFiles: ["src/parent.ts"], candidateLines: 1 },
    { name: "diverse", score: 104, role: "DIVERSE", confirmed: false, parentFiles: ["src/parent.ts"], parentLines: 1, candidateFiles: ["src/diverse.ts"], candidateLines: 10 },
    { name: "ordinary", score: 110, role: undefined, confirmed: false, parentFiles: ["src/parent.ts"], parentLines: 1, candidateFiles: ["src/ordinary.ts"], candidateLines: 10 },
  ] as const;
  const fixtures = await Promise.all(cases.map(() => repository(script)));
  t.after(() => Promise.all([...fixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true })), rm(trace, { force: true })]));

  for (const [index, item] of cases.entries()) {
    const fixture = fixtures[index]!;
    const configured = spec(fixture.root);
    configured.evaluator = {
      ...configured.evaluator,
      env: { TRACE: trace, CASE: item.name, CANDIDATE_SCORE: String(item.score) },
    };
    const input = productionGate(fixture, item);
    const result = await new Evaluator({
      commandExecutor: new NodeProcessExecutor(),
      workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: `production-gate-${item.name}` }),
    }).evaluate(configured, input.candidate, input.parent, input.gate);

    assert.equal(result.confirmationAttempted, item.role !== undefined);
    assert.equal(result.confirmed, item.confirmed);
    assert.equal(result.evidence?.confirmation?.promotionRole, item.role);
    assert.equal(result.evidence?.logs.length, item.role === undefined ? 1 : 3);
  }
  assert.equal(
    await readFile(trace, "utf8"),
    "best:candidate\nbest:parent\nbest:candidate\nlean:candidate\nlean:parent\nlean:candidate\ndiverse:candidate\ndiverse:parent\ndiverse:candidate\nordinary:candidate\n",
  );
});

test("evaluator confirms only would-be LEAN or DIVERSE promotions", async (t) => {
  const trace = join(tmpdir(), `frontier-role-gate-${Date.now()}-${Math.random()}`);
  const script = [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const kind = readFileSync('source.txt', 'utf8').trim();",
    "appendFileSync(process.env.TRACE, `${kind}\\n`);",
    "console.log(`METRIC score=${kind === 'candidate' ? 90 : 100}`);",
  ].join("\n");
  const lean = await repository(script);
  const diverse = await repository(script);
  t.after(() => Promise.all([
    rm(lean.root, { recursive: true, force: true }),
    rm(diverse.root, { recursive: true, force: true }),
    rm(trace, { force: true }),
  ]));

  for (const [fixture, role] of [[lean, "LEAN"], [diverse, "DIVERSE"]] as const) {
    const configured = spec(fixture.root);
    configured.evaluator = { ...configured.evaluator, env: { TRACE: trace } };
    const result = await new Evaluator({
      commandExecutor: new NodeProcessExecutor(),
      workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: "evaluator" }),
    }).evaluate(configured, fixture.candidate, fixture.parent, ({ initialEvaluation }) => {
      assert.deepEqual(initialEvaluation.samples.score, [90]);
      return role;
    });

    assert.equal(result.confirmed, true);
    assert.equal(result.evidence?.confirmation?.promotionRole, role);
  }
  assert.equal(await readFile(trace, "utf8"), "candidate\nparent\ncandidate\ncandidate\nparent\ncandidate\n");
});

test("evaluator runs a primary improvement once when the role-aware gate rejects it", async (t) => {
  const trace = join(tmpdir(), `frontier-role-reject-${Date.now()}-${Math.random()}`);
  const fixture = await repository([
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const kind = readFileSync('source.txt', 'utf8').trim();",
    "appendFileSync(process.env.TRACE, `${kind}\\n`);",
    "console.log(`METRIC score=${kind === 'candidate' ? 90 : 100}`);",
  ].join("\n"));
  t.after(() => Promise.all([rm(fixture.root, { recursive: true, force: true }), rm(trace, { force: true })]));

  const configured = spec(fixture.root);
  configured.evaluator = { ...configured.evaluator, env: { TRACE: trace } };
  const result = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: "evaluator" }),
  }).evaluate(configured, fixture.candidate, fixture.parent, ({ initialEvaluation }) => {
    assert.deepEqual(initialEvaluation.samples.score, [90]);
    return undefined;
  });

  assert.equal(result.confirmationAttempted, false);
  assert.equal(await readFile(trace, "utf8"), "candidate\n");
});

test("evaluator rejects non-zero exits and timeouts", async (t) => {
  const cases = [
    {
      script: "console.log('METRIC score=90'); process.exit(7);",
      timeoutMs: 1_000,
      reason: /exit code 7/,
    },
    {
      script: "await new Promise((resolve) => setTimeout(resolve, 150)); console.log('METRIC score=90');",
      timeoutMs: 25,
      reason: /timed out/,
    },
  ];
  for (const item of cases) {
    const fixture = await repository(item.script);
    try {
      const configured = spec(fixture.root);
      configured.evaluator = { ...configured.evaluator, timeoutMs: item.timeoutMs };
      const evaluation = await new Evaluator({
        commandExecutor: new NodeProcessExecutor(),
        workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: "evaluator" }),
      }).evaluate(configured, fixture.candidate, fixture.parent, noPromotionGate);
      assert.equal(evaluation.confirmed, false);
      assert.equal(evaluation.guards.find((guard) => guard.name === "evaluator")?.status, "failed");
      assert.match(evaluation.reason, item.reason);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("evaluator rejects correctness and resource guard failures", async (t) => {
  const correctness = await repository("console.log('METRIC score=90');");
  const resource = await repository("console.log('METRIC score=90'); console.log('METRIC memory_mb=101');");
  t.after(() => Promise.all([
    rm(correctness.root, { recursive: true, force: true }),
    rm(resource.root, { recursive: true, force: true }),
  ]));

  const correctSpec = spec(correctness.root);
  correctSpec.guards = [{
    type: "command",
    name: "correctness",
    command: { command: "exit 3", timeoutMs: 1_000 },
  }];
  const correctResult = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: correctness.root, runId: "evaluator" }),
  }).evaluate(correctSpec, correctness.candidate, correctness.parent, noPromotionGate);
  assert.equal(correctResult.confirmed, false);
  assert.equal(correctResult.guards.find((guard) => guard.name === "correctness")?.status, "failed");
  assert.match(correctResult.reason, /Guard "correctness" failed/);

  const resourceSpec = spec(resource.root);
  resourceSpec.metrics = [
    { name: "score", direction: "lower" },
    { name: "memory_mb", direction: "lower" },
  ];
  resourceSpec.guards = [{ type: "metric", metric: "memory_mb", maximum: 100 }];
  const resourceResult = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: resource.root, runId: "evaluator" }),
  }).evaluate(resourceSpec, resource.candidate, resource.parent, noPromotionGate);
  assert.equal(resourceResult.confirmed, false);
  assert.equal(resourceResult.guards.find((guard) => guard.name === "metric memory_mb")?.status, "failed");
  assert.match(resourceResult.reason, /memory_mb.*exceeds 100/);
});

test("evaluator rejects protected-file mutation", async (t) => {
  const fixture = await repository([
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const candidate = readFileSync('source.txt', 'utf8').trim() === 'candidate';",
    "if (candidate) writeFileSync('protected.txt', 'mutated\\n');",
    "console.log('METRIC score=90');",
  ].join("\n"));
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const evaluation = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: "evaluator" }),
  }).evaluate(spec(fixture.root), fixture.candidate, fixture.parent, noPromotionGate);

  assert.equal(evaluation.confirmed, false);
  assert.equal(evaluation.protectedPathsIntact, false);
  assert.equal(evaluation.guards.find((guard) => guard.name === "protected paths")?.status, "failed");
  assert.equal(await readFile(join(fixture.root, "protected.txt"), "utf8"), "fixed\n");
});

test("evaluator rejects protected and out-of-scope candidate diffs before measurement", async (t) => {
  const fixture = await repository("console.log('METRIC score=90');");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.root, "protected.txt"), "changed\n");
  await git(fixture.root, "commit", "-am", "bypass scope");
  const bypass = {
    ...fixture.candidate,
    commit: await git(fixture.root, "rev-parse", "HEAD"),
    diffSummary: { changedFiles: ["protected.txt"], changedLines: 1 },
  };

  const evaluation = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: "evaluator" }),
  }).evaluate(spec(fixture.root), bypass, fixture.parent, noPromotionGate);

  assert.equal(evaluation.scopeValid, false);
  assert.equal(evaluation.protectedPathsIntact, false);
  assert.equal(evaluation.evidence?.logs.length, 0);
  assert.match(evaluation.reason, /editable scope/);
});

test("evaluator calibrates zero-noise and outlier samples with robust summaries", async (t) => {
  const script = [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const values = JSON.parse(process.env.VALUES);",
    "const counter = process.env.COUNTER;",
    "const index = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;",
    "writeFileSync(counter, String(index + 1));",
    "console.log(`METRIC score=${values[index]}`);",
  ].join("\n");
  const zero = await repository(script);
  const outlier = await repository(script);
  const zeroCounter = join(tmpdir(), `frontier-zero-${Date.now()}-${Math.random()}`);
  const outlierCounter = join(tmpdir(), `frontier-outlier-${Date.now()}-${Math.random()}`);
  t.after(() => Promise.all([
    rm(zero.root, { recursive: true, force: true }),
    rm(outlier.root, { recursive: true, force: true }),
    rm(zeroCounter, { force: true }),
    rm(outlierCounter, { force: true }),
  ]));

  const zeroSpec = spec(zero.root);
  zeroSpec.evaluator = { ...zeroSpec.evaluator, env: { VALUES: "[100,100,100]", COUNTER: zeroCounter } };
  const zeroResult = await new Evaluator({ commandExecutor: new NodeProcessExecutor() }).calibrate(zeroSpec);
  assert.deepEqual(zeroResult.samples.score, [100, 100, 100]);
  assert.equal(zeroResult.summaries.score?.median, 100);
  assert.equal(zeroResult.summaries.score?.medianAbsoluteDeviation, 0);

  const outlierSpec = spec(outlier.root);
  outlierSpec.baseline = { samples: 5 };
  outlierSpec.evaluator = {
    ...outlierSpec.evaluator,
    env: { VALUES: "[100,1000,101,99,100]", COUNTER: outlierCounter },
  };
  const outlierResult = await new Evaluator({ commandExecutor: new NodeProcessExecutor() }).calibrate(outlierSpec);
  assert.deepEqual(outlierResult.samples.score, [100, 1000, 101, 99, 100]);
  assert.equal(outlierResult.summaries.score?.median, 100);
  assert.equal(outlierResult.summaries.score?.medianAbsoluteDeviation, 1);
});

test("evaluator confirms higher and lower improvements with interleaved measurements", async (t) => {
  const trace = join(tmpdir(), `frontier-confirmation-trace-${Date.now()}-${Math.random()}`);
  const lower = await repository([
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const kind = readFileSync('source.txt', 'utf8').trim();",
    "appendFileSync(process.env.TRACE, `${kind}\\n`);",
    "console.log(`METRIC score=${kind === 'candidate' ? 90 : 100}`);",
  ].join("\n"));
  const higher = await repository([
    "import { readFileSync } from 'node:fs';",
    "console.log(`METRIC score=${readFileSync('source.txt', 'utf8').trim() === 'candidate' ? 110 : 100}`);",
  ].join("\n"));
  t.after(() => Promise.all([
    rm(lower.root, { recursive: true, force: true }),
    rm(higher.root, { recursive: true, force: true }),
    rm(trace, { force: true }),
  ]));

  const lowerSpec = spec(lower.root);
  lowerSpec.evaluator = { ...lowerSpec.evaluator, env: { TRACE: trace } };
  const lowerResult = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: lower.root, runId: "evaluator" }),
  }).evaluate(lowerSpec, lower.candidate, lower.parent, () => "BEST");
  assert.equal(lowerResult.confirmed, true);
  assert.deepEqual(lowerResult.evidence?.confirmation?.pairedSamples.map((pair) => [pair.parent.score, pair.candidate.score]), [[100, 90]]);
  assert.equal(await readFile(trace, "utf8"), "candidate\nparent\ncandidate\n");

  const higherSpec = spec(higher.root);
  higherSpec.metrics = [{ name: "score", direction: "higher" }];
  const higherResult = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: higher.root, runId: "evaluator" }),
  }).evaluate(higherSpec, higher.candidate, higher.parent, () => "BEST");
  assert.equal(higherResult.confirmed, true);
  assert.deepEqual(higherResult.samples.score, [110, 110]);
});

test("evaluator rejects noisy regressions and exhausts inconclusive confirmations", async (t) => {
  const script = [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const candidate = readFileSync('source.txt', 'utf8').trim() === 'candidate';",
    "if (!candidate) console.log('METRIC score=100');",
    "else {",
    "  const values = JSON.parse(process.env.VALUES);",
    "  const counter = process.env.COUNTER;",
    "  const index = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;",
    "  writeFileSync(counter, String(index + 1));",
    "  console.log(`METRIC score=${values[index]}`);",
    "}",
  ].join("\n");
  const rejection = await repository(script);
  const exhaustion = await repository(script);
  const rejectionCounter = join(tmpdir(), `frontier-rejection-${Date.now()}-${Math.random()}`);
  const exhaustionCounter = join(tmpdir(), `frontier-exhaustion-${Date.now()}-${Math.random()}`);
  t.after(() => Promise.all([
    rm(rejection.root, { recursive: true, force: true }),
    rm(exhaustion.root, { recursive: true, force: true }),
    rm(rejectionCounter, { force: true }),
    rm(exhaustionCounter, { force: true }),
  ]));

  const rejectedSpec = spec(rejection.root);
  rejectedSpec.evaluator = {
    ...rejectedSpec.evaluator,
    env: { VALUES: "[90,120,120]", COUNTER: rejectionCounter },
  };
  const rejected = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: rejection.root, runId: "evaluator" }),
  }).evaluate(rejectedSpec, rejection.candidate, rejection.parent, () => "BEST");
  assert.equal(rejected.confirmed, false);
  assert.equal(rejected.evidence?.confirmation?.outcome, "rejected");
  assert.equal(rejected.reason, "candidate improvement rejected by confirmation");

  const exhaustedSpec = spec(exhaustion.root);
  exhaustedSpec.evaluator = {
    ...exhaustedSpec.evaluator,
    env: { VALUES: "[90,100,120]", COUNTER: exhaustionCounter },
  };
  const exhausted = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: exhaustion.root, runId: "evaluator" }),
  }).evaluate(exhaustedSpec, exhaustion.candidate, exhaustion.parent, () => "BEST");
  assert.equal(exhausted.confirmed, false);
  assert.equal(exhausted.evidence?.confirmation?.outcome, "exhausted");
  assert.equal(exhausted.reason, "confirmation sample cap reached");
});

test("evaluator ignores worker-supplied metrics and requested status", async (t) => {
  const fixture = await repository([
    "import { readFileSync } from 'node:fs';",
    "console.log(`METRIC score=${readFileSync('source.txt', 'utf8').trim() === 'candidate' ? 90 : 100}`);",
  ].join("\n"));
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const evaluation = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: "evaluator" }),
  }).evaluate(
    spec(fixture.root),
    { ...fixture.candidate, metricSamples: { score: [1] }, outcome: "rejected" },
    fixture.parent,
    () => "BEST",
  );

  assert.deepEqual(evaluation.samples.score, [90, 90]);
  assert.equal(evaluation.confirmed, true);
  assert.equal(evaluation.reason, "candidate improvement confirmed");
});

test("evaluator confirmation ignores stale parent history", async (t) => {
  const fixture = await repository([
    "import { readFileSync } from 'node:fs';",
    "console.log(`METRIC score=${readFileSync('source.txt', 'utf8').trim() === 'candidate' ? 90 : 100}`);",
  ].join("\n"));
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: "evaluator" }),
  }).evaluate(
    spec(fixture.root),
    fixture.candidate,
    { ...fixture.parent, metricSamples: { score: [1, 1, 1] } },
    () => "BEST",
  );

  assert.equal(result.confirmed, true);
  assert.deepEqual(
    result.evidence?.confirmation?.pairedSamples.map((pair) => [pair.parent.score, pair.candidate.score]),
    [[100, 90]],
  );
});

test("evaluator confirmation ignores the unpaired initial candidate sample", async (t) => {
  const counter = join(tmpdir(), `frontier-unpaired-${Date.now()}-${Math.random()}`);
  const fixture = await repository([
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const candidate = readFileSync('source.txt', 'utf8').trim() === 'candidate';",
    "if (!candidate) console.log('METRIC score=100');",
    "else {",
    "  const values = [1, 101];",
    "  const index = existsSync(process.env.COUNTER) ? Number(readFileSync(process.env.COUNTER, 'utf8')) : 0;",
    "  writeFileSync(process.env.COUNTER, String(index + 1));",
    "  console.log(`METRIC score=${values[index]}`);",
    "}",
  ].join("\n"));
  t.after(() => Promise.all([rm(fixture.root, { recursive: true, force: true }), rm(counter, { force: true })]));

  const configured = spec(fixture.root);
  configured.evaluator = { ...configured.evaluator, env: { COUNTER: counter } };
  const result = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: "evaluator" }),
  }).evaluate(configured, fixture.candidate, fixture.parent, () => "BEST");

  assert.equal(result.confirmed, false);
  assert.equal(result.evidence?.confirmation?.outcome, "rejected");
  assert.deepEqual(
    result.evidence?.confirmation?.pairedSamples.map((pair) => [pair.parent.score, pair.candidate.score]),
    [[100, 101]],
  );
});

test("evaluator fails a late resource threshold violation during confirmation", async (t) => {
  const counter = join(tmpdir(), `frontier-late-guard-${Date.now()}-${Math.random()}`);
  const fixture = await repository([
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const candidate = readFileSync('source.txt', 'utf8').trim() === 'candidate';",
    "if (!candidate) console.log('METRIC score=100\\nMETRIC memory_mb=50');",
    "else {",
    "  const values = [50, 101];",
    "  const index = existsSync(process.env.COUNTER) ? Number(readFileSync(process.env.COUNTER, 'utf8')) : 0;",
    "  writeFileSync(process.env.COUNTER, String(index + 1));",
    "  console.log(`METRIC score=90\\nMETRIC memory_mb=${values[index]}`);",
    "}",
  ].join("\n"));
  t.after(() => Promise.all([rm(fixture.root, { recursive: true, force: true }), rm(counter, { force: true })]));

  const configured = spec(fixture.root);
  configured.metrics = [
    { name: "score", direction: "lower" },
    { name: "memory_mb", direction: "lower" },
  ];
  configured.guards = [{ type: "metric", metric: "memory_mb", maximum: 100 }];
  configured.evaluator = { ...configured.evaluator, env: { COUNTER: counter } };
  const result = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: "evaluator" }),
  }).evaluate(configured, fixture.candidate, fixture.parent, () => "BEST");

  assert.equal(result.confirmed, false);
  assert.equal(result.evidence?.confirmation?.outcome, "failed");
  assert.equal(result.guards.find((guard) => guard.name === "metric memory_mb")?.status, "failed");
  assert.match(result.reason, /memory_mb.*101.*exceeds 100/);
});

test("evaluator fails before confirmation when command guards mutate candidate Git metadata or untracked files", async (t) => {
  for (const item of [
    { name: "untracked file", command: "touch guard-untracked.txt", detail: /tracked or untracked changes/ },
    { name: "Git metadata", command: "printf 'gitdir: /tampered\\n' > .git", detail: /Git marker changed/ },
  ]) {
    const fixture = await repository("console.log('METRIC score=90');");
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const configured = spec(fixture.root);
    configured.guards = [{
      type: "command",
      name: `mutate ${item.name}`,
      command: { command: item.command, timeoutMs: 1_000 },
    }];
    const input = productionGate(fixture, {
      parentFiles: ["src/parent.ts"],
      parentLines: 10,
      candidateFiles: ["src/candidate.ts"],
      candidateLines: 1,
    });

    const result = await new Evaluator({
      commandExecutor: new NodeProcessExecutor(),
      workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: `guard-mutation-${item.name.replaceAll(" ", "-")}` }),
    }).evaluate(configured, input.candidate, input.parent, input.gate);

    assert.equal(result.confirmationAttempted, false);
    assert.deepEqual(result.samples.score, [90]);
    assert.equal(result.evidence?.logs.length, 2);
    assert.equal(result.guards.find((guard) => guard.name === "worktree identity")?.status, "failed");
    assert.match(result.reason, item.detail);
  }
});

test("evaluator fails before further confirmation evidence when the parent evaluator mutates its worktree", async (t) => {
  const fixture = await repository([
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const candidate = readFileSync('source.txt', 'utf8').trim() === 'candidate';",
    "if (!candidate) writeFileSync('confirmation-parent-untracked.txt', 'mutation\\n');",
    "console.log(`METRIC score=${candidate ? 90 : 100}`);",
  ].join("\n"));
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const input = productionGate(fixture, {
    parentFiles: ["src/parent.ts"],
    parentLines: 10,
    candidateFiles: ["src/candidate.ts"],
    candidateLines: 1,
  });

  const result = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: "confirmation-parent-mutation" }),
  }).evaluate(spec(fixture.root), input.candidate, input.parent, input.gate);

  assert.equal(result.confirmationAttempted, true);
  assert.equal(result.evidence?.confirmation?.outcome, "failed");
  assert.deepEqual(result.samples.score, [90]);
  assert.deepEqual(result.evidence?.logs.map((log) => log.label), ["evaluator", "confirmation-parent"]);
  assert.equal(result.guards.find((guard) => guard.name === "worktree identity")?.status, "failed");
  assert.match(result.reason, /tracked or untracked changes/);
});

test("evaluator rejects an evaluator command that mutates its candidate worktree", async (t) => {
  const fixture = await repository([
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "if (readFileSync('source.txt', 'utf8').trim() === 'candidate') writeFileSync('source.txt', 'evaluator mutation\\n');",
    "console.log('METRIC score=90');",
  ].join("\n"));
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = await new Evaluator({
    commandExecutor: new NodeProcessExecutor(),
    workspace: new GitWorkspaceAdapter({ repository: fixture.root, runId: "evaluator" }),
  }).evaluate(spec(fixture.root), fixture.candidate, fixture.parent, () => "BEST");

  assert.equal(result.confirmed, false);
  assert.deepEqual(result.samples, {});
  assert.equal(result.guards.find((guard) => guard.name === "worktree identity")?.status, "failed");
  assert.match(result.reason, /worktree identity/);
  assert.equal(result.evidence?.logs.length, 1);
});
