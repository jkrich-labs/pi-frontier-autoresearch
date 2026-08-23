import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import frontierAutoresearch from "../extensions/pi-frontier-autoresearch/index.ts";
import {
  ConfigurationError,
  ManualClock,
  NodeProcessExecutor,
  RunConfigurator,
  type RunEvent,
  type RunSpec,
  type RunState,
  type StoreAdapter,
  type StoreInitialisationClaim,
  type WorkerMarker,
} from "../src/index.ts";

type Assert<T extends true> = T;
type IsRequiredKey<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;
type _AtomicClaimIsRequired = Assert<IsRequiredKey<StoreAdapter, "claimInitialisation">>;
type _ArtifactInspectionIsRequired = Assert<IsRequiredKey<StoreAdapter, "hasRunArtifacts">>;
type _MarkerInspectionIsRequired = Assert<IsRequiredKey<StoreAdapter, "readWorkerMarker">>;
type _MarkerWriteIsRequired = Assert<IsRequiredKey<StoreAdapter, "writeWorkerMarker">>;
type _MarkerClearIsRequired = Assert<IsRequiredKey<StoreAdapter, "clearWorkerMarker">>;
type _InitialiseConsumesRequiredClaim = Assert<
  Parameters<StoreAdapter["initialise"]> extends [RunSpec, RunState, StoreInitialisationClaim] ? true : false
>;

class MemoryStore implements StoreAdapter {
  initial?: { spec: RunSpec; state: RunState };
  generatedSpec?: string;
  claim?: StoreInitialisationClaim;
  marker?: WorkerMarker;

  async claimInitialisation(_spec: RunSpec): Promise<StoreInitialisationClaim> {
    if (this.initial || this.claim) throw new Error("Durable run state already exists");
    this.claim = { token: "memory-store-claim" };
    return this.claim;
  }
  async initialise(spec: RunSpec, state: RunState, claim: StoreInitialisationClaim): Promise<void> {
    if (claim !== this.claim) throw new Error("Initialisation claim does not belong to this store");
    this.initial = { spec, state };
    this.claim = undefined;
  }
  async writeGeneratedSpec(content: string): Promise<void> {
    this.generatedSpec = content;
  }
  async append(_event: RunEvent): Promise<void> {}
  async snapshot(_state: RunState): Promise<void> {}
  async load(): Promise<{ events: readonly RunEvent[]; snapshot?: RunState }> {
    return { events: [], snapshot: this.initial?.state };
  }
  async hasRunArtifacts(): Promise<boolean> {
    return this.initial !== undefined || this.claim !== undefined || this.marker !== undefined;
  }
  async clear(): Promise<void> {
    this.initial = undefined;
    this.claim = undefined;
    this.marker = undefined;
  }
  async writeWorkerMarker(marker: WorkerMarker): Promise<void> {
    this.marker = marker;
  }
  async readWorkerMarker(): Promise<WorkerMarker | undefined> {
    return this.marker;
  }
  async clearWorkerMarker(): Promise<void> {
    this.marker = undefined;
  }
}

async function fixtureRepository(metricLine = "METRIC build_ms=100"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "frontier-setup-"));
  const script = [
    "import process from 'node:process';",
    `console.log(${JSON.stringify(metricLine)});`,
    "process.exit(0);",
  ].join("\n");
  await writeFile(join(root, "bench.mjs"), script);
  const processRunner = new NodeProcessExecutor();
  await processRunner.run({ command: "git", args: ["init", "-q"], cwd: root });
  await processRunner.run({ command: "git", args: ["config", "user.name", "Fixture"], cwd: root });
  await processRunner.run({ command: "git", args: ["config", "user.email", "fixture@example.test"], cwd: root });
  await writeFile(join(root, "src.ts"), "export const value = 1;\n");
  await processRunner.run({ command: "git", args: ["add", "."], cwd: root });
  await processRunner.run({ command: "git", args: ["commit", "-qm", "fixture"], cwd: root });
  return root;
}

function runSpec(root: string): RunSpec {
  return {
    schemaVersion: 1,
    runId: "build-time",
    targetRepository: root,
    objective: "Reduce build time without changing output",
    primaryMetric: "build_ms",
    metrics: [{ name: "build_ms", direction: "lower" }],
    evaluator: { command: `${JSON.stringify(process.execPath)} bench.mjs`, timeoutMs: 5_000 },
    editableGlobs: ["src.ts"],
    protectedPaths: ["bench.mjs"],
    probes: [],
    guards: [],
    budget: { maxExperiments: 12 },
    baseline: { samples: 3 },
    confirmation: { maxSamples: 5, confidenceMultiplier: 2 },
    frontierPolicy: {
      size: 4,
      leanPrimaryTolerance: 0.02,
      diversePrimaryTolerance: 0.05,
      diverseNoveltyThreshold: 0.35,
      crossoverCadence: 4,
    },
  };
}

async function expectConfigurationError(spec: RunSpec, message: RegExp): Promise<void> {
  const configurator = new RunConfigurator({
    commandExecutor: new NodeProcessExecutor(),
    store: new MemoryStore(),
    clock: new ManualClock(1_000),
  });
  await assert.rejects(configurator.configure(spec), message);
}

test("configure rejects invalid setup contracts before launch", async () => {
  const root = await fixtureRepository();

  await expectConfigurationError({ ...runSpec(root), editableGlobs: [] }, /editableGlobs/);
  for (const runId of [
    "two words",
    "two..dots",
    "name@{one",
    "trailing.",
    "name.lock",
    "-leading",
    "a".repeat(65),
  ]) {
    await expectConfigurationError({ ...runSpec(root), runId }, /runId must be a Git-ref-safe slug/);
  }
  await expectConfigurationError(
    { ...runSpec(root), editableGlobs: ["src/**"], protectedPaths: ["src/generated/**"] },
    /overlaps protected path/,
  );
  await expectConfigurationError({ ...runSpec(root), budget: {} }, /budget must set/);
  await expectConfigurationError(
    { ...runSpec(root), editableGlobs: ["**"], protectedPaths: [] },
    /run state/,
  );

  const nonGit = await mkdtemp(join(tmpdir(), "frontier-nongit-"));
  await expectConfigurationError({ ...runSpec(root), targetRepository: nonGit }, /Git repository/);

  await writeFile(join(root, "fail.mjs"), "process.exit(3);\n");
  await expectConfigurationError(
    { ...runSpec(root), evaluator: { command: `${JSON.stringify(process.execPath)} fail.mjs`, timeoutMs: 5_000 } },
    /Evaluator command failed/,
  );

  await writeFile(join(root, "missing.mjs"), "console.log('benchmark completed');\n");
  await expectConfigurationError(
    { ...runSpec(root), evaluator: { command: `${JSON.stringify(process.execPath)} missing.mjs`, timeoutMs: 5_000 } },
    /primary metric.*missing/,
  );

  await writeFile(join(root, "nonfinite.mjs"), "console.log('METRIC build_ms=Infinity');\n");
  await expectConfigurationError(
    { ...runSpec(root), evaluator: { command: `${JSON.stringify(process.execPath)} nonfinite.mjs`, timeoutMs: 5_000 } },
    /finite number/,
  );

  const counter = join(tmpdir(), `frontier-counter-${Date.now()}`);
  await writeFile(
    join(root, "baseline-fails.mjs"),
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "const counter = process.env.COUNTER;",
      "if (!existsSync(counter)) { writeFileSync(counter, 'dry-run'); console.log('METRIC build_ms=100'); }",
      "else process.exitCode = 2;",
    ].join("\n"),
  );
  await expectConfigurationError(
    {
      ...runSpec(root),
      evaluator: {
        command: `${JSON.stringify(process.execPath)} baseline-fails.mjs`,
        timeoutMs: 5_000,
        env: { COUNTER: counter },
      },
    },
    /zero successful baseline samples/,
  );

  const partialCounter = join(tmpdir(), `frontier-partial-counter-${Date.now()}`);
  await writeFile(
    join(root, "baseline-partial.mjs"),
    [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "const path = process.env.COUNTER;",
      "const count = existsSync(path) ? Number(readFileSync(path, 'utf8')) + 1 : 1;",
      "writeFileSync(path, String(count));",
      "if (count <= 2) console.log('METRIC build_ms=100'); else process.exitCode = 2;",
    ].join("\n"),
  );
  await expectConfigurationError(
    {
      ...runSpec(root),
      evaluator: {
        command: `${JSON.stringify(process.execPath)} baseline-partial.mjs`,
        timeoutMs: 5_000,
        env: { COUNTER: partialCounter },
      },
    },
    /collected 1 of 3 required samples/,
  );

  await expectConfigurationError(
    { ...runSpec(root), guards: [{ type: "metric", metric: "build_ms", maximum: 90 }] },
    /Baseline violates metric guard/,
  );
});

test("configure calibrates and persists a generic build-time run", async () => {
  const root = await fixtureRepository("METRIC build_ms=100\nMETRIC memory_mb=50");
  const store = new MemoryStore();
  const configurator = new RunConfigurator({
    commandExecutor: new NodeProcessExecutor(),
    store,
    clock: new ManualClock(1_700_000_000_000),
  });

  const spec: RunSpec = {
    ...runSpec(root),
    metrics: [
      { name: "build_ms", direction: "lower" },
      { name: "memory_mb", direction: "lower", guard: { maximum: 80 } },
    ],
    guards: [
      { type: "metric", metric: "memory_mb", maximum: 80 },
      { type: "changed-lines", maximum: 200 },
    ],
  };
  const configured = await configurator.configure(spec);

  assert.deepEqual(configured.state.baseline?.samples.build_ms, [100, 100, 100]);
  assert.equal(configured.state.baseline?.summaries.build_ms?.median, 100);
  assert.equal(configured.state.baseline?.summaries.build_ms?.medianAbsoluteDeviation, 0);
  assert.equal(store.initial?.state.status, "configured");
  assert.equal(store.claim, undefined, "successful initialisation consumes its atomic claim");
  for (const text of [
    "Reduce build time",
    "build_ms",
    "memory_mb.*lower",
    "maximum.*80",
    "changed-lines",
    "maximum.*200",
    "bench.mjs",
    "src.ts",
    "bench.mjs",
    "guards",
    "12 experiments",
    "Completion criteria",
  ]) {
    assert.match(configured.generatedSpec, new RegExp(text, "i"));
  }
  assert.match(configured.generatedSpec, /Configuration digest: [a-f0-9]{64}/);
  assert.equal(store.generatedSpec, configured.generatedSpec);
  assert.ok(configured.state.spec.protectedPaths.includes(".frontier-autoresearch/**"));

  const original = structuredClone(store.initial);
  await assert.rejects(
    () => configurator.configure(spec),
    /durable run state already exists.*clear/i,
  );
  assert.deepEqual(store.initial, original, "reconfiguration must preserve the original durable setup");
  assert.equal(store.generatedSpec, configured.generatedSpec);
});

test("prompt commands invoke setup without starting a run", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: string[] = [];
  const activeTools: string[][] = [];
  const fakePi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options);
    },
    registerTool() {},
    getActiveTools: () => ["read"],
    setActiveTools(tools: string[]) {
      activeTools.push(tools);
    },
    sendUserMessage(message: string) {
      sent.push(message);
    },
    on() {},
  } as unknown as ExtensionAPI;

  frontierAutoresearch(fakePi);
  const context = { isIdle: () => true, ui: { notify() {} } };
  await commands.get("autoresearch-prompt")?.handler("reduce build time", context);
  await commands.get("autoresearch")?.handler("reduce test time", context);

  assert.deepEqual(sent, [
    "/skill:autoresearch-setup reduce build time",
    "/skill:autoresearch-setup reduce test time",
  ]);
  assert.ok(activeTools.every((tools) => tools.includes("autoresearch_configure")));
  assert.equal(sent.some((message) => message.includes(" start")), false);
});

test("input handler activates the configure tool for direct and expanded setup skill invocations", async () => {
  const handlers = new Map<string, (event: { text: string }) => void>();
  const activeTools: string[][] = [];
  const fakePi = {
    registerCommand() {},
    registerTool() {},
    getActiveTools: () => ["read"],
    setActiveTools(tools: string[]) {
      activeTools.push(tools);
    },
    sendUserMessage() {},
    on(event: string, handler: (event: { text: string }) => void) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  frontierAutoresearch(fakePi);
  const input = handlers.get("input");
  assert.ok(input, "extension must register an input handler");

  input({ text: "/skill:autoresearch-setup reduce build time" });
  input({ text: "<skill name=\"autoresearch-setup\" location=\"/some/path\">…</skill>" });
  input({ text: "/autoresearch start" });
  input({ text: "unrelated prompt" });

  assert.ok(activeTools.length >= 2, "setup invocations must activate the configure tool");
  assert.ok(activeTools.every((tools) => tools.includes("autoresearch_configure")));
  assert.equal(activeTools.length, 2, "non-setup input must not reactivate the tool");
});

test("ConfigurationError remains an explicit caller contract", () => {
  assert.equal(new ConfigurationError("bad setup").name, "ConfigurationError");
});
