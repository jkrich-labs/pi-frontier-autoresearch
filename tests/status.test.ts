import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import frontierAutoresearch, { registerFrontierAutoresearch } from "../extensions/pi-frontier-autoresearch/index.ts";
import { detectAutoresearchCommandConflict } from "../src/command-conflict.ts";
import {
  FrontierStatusPresenter,
  type IntervalScheduler,
  type StatusPresentationContext,
} from "../src/status-presentation.ts";
import { renderFrontierFooter, renderFrontierStatus } from "../src/status-renderer.ts";
import { LocalRunStore, NodeProcessExecutor, type RunSpec, type RunState } from "../src/index.ts";

function fixtureState(overrides: Partial<RunState> = {}): RunState {
  const nodes = {
    best: node("best", 80),
    lean: node("lean", 90),
    "diverse-a": node("diverse-a", 92),
    "diverse-b": node("diverse-b", 95),
  };
  return {
    spec: {
      schemaVersion: 1,
      runId: "visual-fixture",
      targetRepository: "/fixture",
      objective: "Reduce the very long and deliberately descriptive build time for the fixture project",
      primaryMetric: "build_ms",
      metrics: [{ name: "build_ms", direction: "lower" }],
      evaluator: { command: "node bench.mjs", timeoutMs: 5_000 },
      editableGlobs: ["src/**"],
      protectedPaths: ["bench.mjs"],
      probes: [],
      guards: [],
      budget: { maxExperiments: 10, maxWallTimeMs: 120_000, maxReportedCostUsd: 3 },
      baseline: { samples: 3 },
      confirmation: { maxSamples: 5, confidenceMultiplier: 2 },
      frontierPolicy: {
        size: 4,
        leanPrimaryTolerance: 0.02,
        diversePrimaryTolerance: 0.05,
        diverseNoveltyThreshold: 0.35,
        crossoverCadence: 4,
      },
      policyTuning: { enabled: false },
    },
    status: "running",
    baseline: {
      samples: { build_ms: [100, 100, 100] },
      summaries: {
        build_ms: { median: 100, medianAbsoluteDeviation: 0, minimum: 100, maximum: 100 },
      },
      calibratedAt: "2026-03-01T00:00:00.000Z",
    },
    nodes,
    frontier: [
      { index: 0, role: "BEST", nodeId: "best" },
      { index: 1, role: "LEAN", nodeId: "lean" },
      { index: 2, role: "DIVERSE", nodeId: "diverse-a" },
      { index: 3, role: "DIVERSE", nodeId: "diverse-b" },
    ],
    activeAssignment: {
      experimentId: "experiment-0003",
      operator: "crossover",
      primaryParentId: "best",
      donorParentId: "lean",
      hypothesis: "Transplant the long-lived cache without weakening the build output guard",
      policyVersion: 2,
    },
    budgetUsage: { experiments: 2, wallTimeMs: 30_000, reportedCostUsd: 1.25 },
    policyVersion: 2,
    activePolicy: {
      version: 2,
      frontier: {
        size: 4,
        leanPrimaryTolerance: 0.02,
        diversePrimaryTolerance: 0.05,
        diverseNoveltyThreshold: 0.35,
        crossoverCadence: 4,
      },
      weights: { productivity: 1, exploration: 1, novelty: 1, coverage: 1, recency: 1, pairRepetitionPenalty: 1 },
    },
    policyHistory: [],
    lastEventIndex: 12,
    latestDecision: "Promoted the cache candidate after a deliberately long confirmation decision that must never overflow the terminal.",
    ...overrides,
  };
}

function node(id: string, metric: number) {
  return {
    id,
    commit: id,
    ref: `refs/frontier/${id}`,
    parentIds: [],
    operator: "mutation" as const,
    hypothesis: id,
    reflection: id,
    diffSummary: { changedFiles: [], changedLines: 1 },
    metricSamples: { build_ms: [metric] },
    guardResults: [],
    outcome: "promoted" as const,
    policyVersion: 1,
    createdEventIndex: 1,
    selection: { attempts: 0, promotions: 0 },
  };
}

function normalized(lines: readonly string[]): string {
  return lines.join("\n").replace(/\s+/g, " ").trim();
}

function unbroken(lines: readonly string[]): string {
  return lines.join("");
}

function expectedState(state: RunState): string {
  return state.status === "completed" && state.budgetUsage.experiments >= (state.spec.budget.maxExperiments ?? Infinity)
    ? "budget exhausted"
    : state.status;
}

function assertFullProjection(state: RunState, width: number): void {
  const lines = renderFrontierStatus(state, width);
  const text = normalized(lines);
  assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}: ${JSON.stringify(lines)}`);
  assert.match(text, new RegExp(`Frontier: ${expectedState(state)}`));
  assert.match(text, /8\/10 experiments/);
  assert.match(text, /1m 30s wall time/);
  assert.match(text, /US\$1\.75 cost/);
  assert.match(text, /Metric: build_ms baseline=100 best=80/);
  assert.match(
    text,
    state.activeAssignment
      ? /Active: experiment-0003 crossover best \+ lean/
      : /Active: none/,
  );
  assert.match(text, /BEST: best/);
  assert.match(text, /LEAN: lean/);
  assert.match(text, /DIVERSE 1: diverse-a/);
  assert.match(text, /DIVERSE 2: diverse-b/);
  assert.match(text, /Promoted the cache candidate after a deliberately long confirmation decision that must never overflow the terminal\./);
  assert.match(
    text,
    new RegExp(`Policy: ${state.spec.policyTuning?.enabled ? "experimental" : "fixed"} v${state.activePolicy.version}`),
  );
}

test("status render state matrix preserves all required values at narrow, normal, and wide widths", () => {
  const states: Array<readonly [string, RunState | undefined]> = [
    ["empty", undefined],
    ["running", fixtureState()],
    ["paused", fixtureState({ status: "paused", activeAssignment: undefined })],
    [
      "failed",
      fixtureState({
        status: "failed",
        activeAssignment: undefined,
        spec: { ...fixtureState().spec, policyTuning: { enabled: true } },
        activePolicy: { ...fixtureState().activePolicy, version: 7 },
        policyVersion: 7,
      }),
    ],
    ["stopped", fixtureState({ status: "stopped", activeAssignment: undefined })],
    [
      "budget exhausted",
      fixtureState({
        status: "completed",
        activeAssignment: undefined,
        budgetUsage: { experiments: 10, wallTimeMs: 120_000, reportedCostUsd: 3 },
      }),
    ],
  ];

  for (const width of [24, 64, 120]) {
    for (const [name, state] of states) {
      const lines = renderFrontierStatus(state, width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `${name}/${width}: ${JSON.stringify(lines)}`);
      if (!state) {
        assert.match(normalized(lines), /Frontier: no configured run\./, `${name}/${width}`);
        continue;
      }
      if (name === "budget exhausted") {
        assert.match(normalized(lines), /Frontier: budget exhausted/, `${name}/${width}`);
        assert.match(normalized(lines), /0\/10 experiments/, `${name}/${width}`);
        assert.match(normalized(lines), /0s wall time/, `${name}/${width}`);
        assert.match(normalized(lines), /US\$0 cost/, `${name}/${width}`);
        assert.match(normalized(lines), /Active: none/, `${name}/${width}`);
        assert.match(normalized(lines), /Metric: build_ms baseline=100 best=80/, `${name}/${width}`);
        assert.match(normalized(lines), /BEST: best/, `${name}/${width}`);
        assert.match(normalized(lines), /LEAN: lean/, `${name}/${width}`);
        assert.match(normalized(lines), /DIVERSE 1: diverse-a/, `${name}/${width}`);
        assert.match(normalized(lines), /DIVERSE 2: diverse-b/, `${name}/${width}`);
        assert.match(normalized(lines), /Decision: Promoted the cache candidate/, `${name}/${width}`);
        assert.match(normalized(lines), /Policy: fixed v2/, `${name}/${width}`);
      } else {
        assertFullProjection(state, width);
      }
    }
  }
});

test("status render wraps long unbroken semantic values without dropping them", () => {
  const token = "x".repeat(96);
  const metric = `metric-${token}`;
  const ids = {
    best: `best-${token}`,
    lean: `lean-${token}`,
    diverseOne: `diverse-one-${token}`,
    diverseTwo: `diverse-two-${token}`,
    assignment: `experiment-${token}`,
    decision: `decision-${token}`,
  };
  const longNode = (id: string, value: number) => ({ ...node(id, value), metricSamples: { [metric]: [value] } });
  const state = fixtureState({
    spec: { ...fixtureState().spec, primaryMetric: metric, metrics: [{ name: metric, direction: "lower" }] },
    baseline: {
      samples: { [metric]: [100, 100, 100] },
      summaries: { [metric]: { median: 100, medianAbsoluteDeviation: 0, minimum: 100, maximum: 100 } },
      calibratedAt: "2026-03-01T00:00:00.000Z",
    },
    nodes: {
      [ids.best]: longNode(ids.best, 80),
      [ids.lean]: longNode(ids.lean, 90),
      [ids.diverseOne]: longNode(ids.diverseOne, 92),
      [ids.diverseTwo]: longNode(ids.diverseTwo, 95),
    },
    frontier: [
      { index: 0, role: "BEST", nodeId: ids.best },
      { index: 1, role: "LEAN", nodeId: ids.lean },
      { index: 2, role: "DIVERSE", nodeId: ids.diverseOne },
      { index: 3, role: "DIVERSE", nodeId: ids.diverseTwo },
    ],
    activeAssignment: {
      ...fixtureState().activeAssignment!,
      experimentId: ids.assignment,
      primaryParentId: ids.best,
      donorParentId: ids.lean,
    },
    latestDecision: ids.decision,
  });

  for (const width of [24, 64, 120]) {
    const lines = renderFrontierStatus(state, width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}: ${JSON.stringify(lines)}`);
    const whole = unbroken(lines);
    for (const value of [metric, ids.best, ids.lean, ids.diverseOne, ids.diverseTwo, ids.assignment, ids.decision]) {
      assert.ok(whole.includes(value), `${width} lost ${value.slice(0, 24)}`);
    }
    assert.match(normalized(lines), /8\/10 experiments/);
    assert.match(normalized(lines), /baseline=100 best=80/);
    assert.match(normalized(lines), /Policy: fixed v2/);
  }
});

test("widget footer is compact and state-only even for a narrow footer", () => {
  const states = [
    undefined,
    fixtureState(),
    fixtureState({ status: "failed", activeAssignment: undefined }),
    fixtureState({
      status: "completed",
      activeAssignment: undefined,
      budgetUsage: { experiments: 10, wallTimeMs: 120_000, reportedCostUsd: 3 },
    }),
  ];
  for (const state of states) {
    const footer = renderFrontierFooter(state);
    assert.ok(visibleWidth(footer) <= 32, footer);
    assert.doesNotMatch(footer, /remaining|Metric:|Active:|BEST:|Decision:|Policy:/i, footer);
  }
  assert.equal(renderFrontierFooter(fixtureState()), "Frontier: running");
  assert.equal(renderFrontierFooter(states.at(-1)), "Frontier: budget exhausted");
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function tuiContext(events: {
  widgets: unknown[];
  statuses: Array<string | undefined>;
  notifications: string[];
}): StatusPresentationContext {
  return {
    mode: "tui",
    cwd: "/fixture",
    ui: {
      notify(message: string) { events.notifications.push(message); },
      setWidget(_key: string, value: unknown) { events.widgets.push(value); },
      setStatus(_key: string, value: string | undefined) { events.statuses.push(value); },
    },
  } as unknown as StatusPresentationContext;
}

test("widget presenter serializes polling, suppresses stale loads, and awaits shutdown before clearing", async () => {
  const pending: Array<Deferred<RunState | undefined>> = [];
  let interval: (() => void) | undefined;
  let clearCalls = 0;
  const scheduler: IntervalScheduler = {
    setInterval(callback) { interval = callback; return 1; },
    clearInterval() { clearCalls++; },
  };
  const events = { widgets: [] as unknown[], statuses: [] as Array<string | undefined>, notifications: [] as string[] };
  const presenter = new FrontierStatusPresenter(async () => {
    const next = deferred<RunState | undefined>();
    pending.push(next);
    return await next.promise;
  }, scheduler);
  const context = tuiContext(events);

  const starting = presenter.start(context);
  await turn();
  assert.equal(pending.length, 1);
  pending[0]!.resolve(fixtureState({ status: "running" }));
  await starting;
  assert.match(events.statuses.at(-1) ?? "", /running/);
  const widgetFactory = events.widgets.find((entry): entry is (tui: { requestRender(): void }) => { render(width: number): string[] } =>
    typeof entry === "function",
  );
  assert.ok(widgetFactory);
  const narrowWidget = widgetFactory({ requestRender() {} }).render(24);
  assert.ok(narrowWidget.every((line) => visibleWidth(line) <= 24));
  assert.match(normalized(narrowWidget), /Metric: build_ms baseline=100 best=80/);

  interval?.();
  await turn();
  assert.equal(pending.length, 2);
  interval?.();
  await turn();
  assert.equal(pending.length, 2, "an interval poll must not overlap an in-flight poll");

  const current = presenter.refresh(context);
  const publishesBeforeStaleResolution = events.statuses.length;
  pending[1]!.resolve(fixtureState({ status: "running" }));
  await turn();
  assert.equal(pending.length, 3, "a newer manual refresh runs only after the stale poll settles");
  assert.equal(events.statuses.length, publishesBeforeStaleResolution, "the stale poll did not publish after a newer request");
  pending[2]!.resolve(fixtureState({ status: "paused", activeAssignment: undefined }));
  await current;
  assert.match(events.statuses.at(-1) ?? "", /paused/);

  interval?.();
  await turn();
  assert.equal(pending.length, 4);
  let shutdownFinished = false;
  const shuttingDown = presenter.shutdown(context).then(() => { shutdownFinished = true; });
  await turn();
  assert.equal(shutdownFinished, false, "shutdown waits for the invalidated load");
  pending[3]!.resolve(fixtureState({ status: "running" }));
  await shuttingDown;
  assert.equal(clearCalls, 1);
  assert.equal(events.widgets.at(-1), undefined);
  assert.equal(events.statuses.at(-1), undefined);
  const callsAfterClear = events.statuses.length;
  interval?.();
  await turn();
  assert.equal(events.statuses.length, callsAfterClear, "an old timer cannot repaint after shutdown");
});

test("widget presenter shutdown contains independently throwing disposed UI cleanup", async () => {
  const calls: string[] = [];
  let disposed = false;
  const presenter = new FrontierStatusPresenter(async () => fixtureState());
  const context = {
    mode: "tui" as const,
    cwd: "/fixture",
    ui: {
      notify() {},
      setWidget() {
        calls.push("setWidget");
        if (disposed) throw new Error("widget UI disposed");
      },
      setStatus() {
        calls.push("setStatus");
        if (disposed) throw new Error("status UI disposed");
      },
    },
  } as unknown as StatusPresentationContext;

  await presenter.start(context);
  disposed = true;
  await assert.doesNotReject(presenter.shutdown(context));
  assert.deepEqual(calls.slice(-2), ["setWidget", "setStatus"]);
});

test("widget polling contains bounded failures without unhandled rejections or notification storms", async () => {
  let calls = 0;
  let interval: (() => void) | undefined;
  const events = { widgets: [] as unknown[], statuses: [] as Array<string | undefined>, notifications: [] as string[] };
  const presenter = new FrontierStatusPresenter(async () => {
    calls++;
    if (calls === 1) return fixtureState();
    throw new Error("broken-status-".repeat(80));
  }, {
    setInterval(callback) { interval = callback; return 1; },
    clearInterval() {},
  });
  const context = tuiContext(events);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    await presenter.start(context);
    interval?.();
    await turn();
    interval?.();
    await turn();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.equal(calls, 3);
  assert.equal(unhandled.length, 0);
  assert.equal(events.notifications.length, 1);
  assert.ok((events.notifications[0] ?? "").length <= 200, events.notifications[0]);
  assert.equal(events.statuses.at(-1), "Frontier: status refresh failed");
  await presenter.shutdown(context);
});

function extensionHarness(): {
  pi: ExtensionAPI;
  commands: Map<string, { handler: (args: string, context: unknown) => Promise<void> }>;
  tools: Map<string, { execute: (...args: any[]) => Promise<any> }>;
  handlers: Map<string, (event: unknown, context: unknown) => Promise<void> | void>;
  sentUsers: string[];
  sentMessages: string[];
} {
  const commands = new Map<string, { handler: (args: string, context: unknown) => Promise<void> }>();
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void> | void>();
  const sentUsers: string[] = [];
  const sentMessages: string[] = [];
  const pi = {
    registerCommand(name: string, command: { handler: (args: string, context: unknown) => Promise<void> }) { commands.set(name, command); },
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.set(tool.name, tool); },
    getActiveTools: () => ["read"],
    setActiveTools() {},
    sendUserMessage(content: string) { sentUsers.push(content); },
    sendMessage(message: { content: string }) { sentMessages.push(message.content); },
    getCommands: () => [],
    on(event: string, handler: (event: unknown, context: unknown) => Promise<void> | void) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  return { pi, commands, tools, handlers, sentUsers, sentMessages };
}

async function repository(t: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  await new NodeProcessExecutor().run({ command: "git", args: ["init", "-q"], cwd: root });
  return root;
}

function configSpec(root: string, runId = "non-tui-config"): RunSpec {
  const spec = fixtureState().spec;
  return {
    ...spec,
    runId,
    targetRepository: root,
    evaluator: { command: "printf 'METRIC build_ms=100\\n'", timeoutMs: 5_000 },
    baseline: { samples: 1 },
    budget: { maxExperiments: 1 },
  };
}

async function writeActionState(root: string, status: RunState["status"], runId: string): Promise<void> {
  const spec = configSpec(root, runId);
  const state = fixtureState({
    spec,
    status,
    nodes: { baseline: { ...node("baseline", 100), operator: "baseline", outcome: "promoted" } },
    frontier: [{ index: 0, role: "BEST", nodeId: "baseline" }],
    activeAssignment: undefined,
    budgetUsage: { experiments: 1, wallTimeMs: 0, reportedCostUsd: 0 },
  });
  await new LocalRunStore(root).initialise(spec, state);
}

test("widget extension reload reconstructs durable detailed status after old lifecycle shutdown", async (t) => {
  const root = await repository(t, "frontier-reload-");
  await writeActionState(root, "completed", "durable-reload");
  const statuses: Array<string | undefined> = [];
  const widgets: unknown[] = [];
  const ui = {
    notify() {},
    setWidget(_key: string, value: unknown) { widgets.push(value); },
    setStatus(_key: string, value: string | undefined) { statuses.push(value); },
  };
  const context = { mode: "tui", cwd: root, hasUI: true, ui };

  const oldRuntime = extensionHarness();
  frontierAutoresearch(oldRuntime.pi);
  await oldRuntime.handlers.get("session_start")?.({}, context);
  assert.match(statuses.at(-1) ?? "", /budget exhausted/);
  await oldRuntime.handlers.get("session_shutdown")?.({}, context);
  assert.equal(statuses.at(-1), undefined);

  const reloadedRuntime = extensionHarness();
  frontierAutoresearch(reloadedRuntime.pi);
  await reloadedRuntime.handlers.get("session_start")?.({}, context);
  assert.match(statuses.at(-1) ?? "", /budget exhausted/, "the new extension rebuilds from durable run state");
  const widgetFactory = widgets.findLast((entry): entry is (tui: { requestRender(): void }) => { render(width: number): string[] } =>
    typeof entry === "function",
  );
  assert.ok(widgetFactory, "the reload installs a reconstructed detailed widget");
  const detailed = normalized(widgetFactory({ requestRender() {} }).render(120));
  assert.match(detailed, /Frontier: budget exhausted/);
  assert.match(detailed, /Metric: build_ms baseline=100 best=100/);
  assert.match(detailed, /BEST: baseline/);
  assert.match(detailed, /Policy: fixed v2/);
  await reloadedRuntime.handlers.get("session_shutdown")?.({}, context);
});

test("command conflict is provenance-only and returns before filesystem or store runtime access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "frontier-conflict-"));
  const legacy = join(root, ".auto");
  await mkdir(legacy);
  await writeFile(join(legacy, "legacy-state.json"), "leave untouched\n");
  const before = {
    content: await readFile(join(legacy, "legacy-state.json"), "utf8"),
    mode: (await stat(legacy)).mode,
    modified: (await stat(legacy)).mtimeMs,
  };
  t.after(() => rm(root, { recursive: true, force: true }));

  const accesses: PropertyKey[] = [];
  const provenance = (name: string, source: string, path: string) => new Proxy({
    name,
    source: "extension",
    sourceInfo: new Proxy({ source, path }, {
      get(target, property, receiver) {
        accesses.push(property);
        if (property !== "source" && property !== "path") throw new Error(`unexpected source metadata access: ${String(property)}`);
        return Reflect.get(target, property, receiver);
      },
    }),
  }, {
    get(target, property, receiver) {
      accesses.push(property);
      if (property !== "name" && property !== "source" && property !== "sourceInfo") {
        throw new Error(`unexpected command access: ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const commands = [
    provenance("autoresearch:1", "pi-autoresearch", "/packages/pi-autoresearch/index.ts"),
    provenance("autoresearch:2", "pi-frontier-autoresearch", "/packages/pi-frontier-autoresearch/extensions/pi-frontier-autoresearch/index.ts"),
  ];
  const conflict = detectAutoresearchCommandConflict(commands);
  assert.deepEqual(conflict, {
    ours: "pi-frontier-autoresearch (/packages/pi-frontier-autoresearch/extensions/pi-frontier-autoresearch/index.ts)",
    other: "pi-autoresearch (/packages/pi-autoresearch/index.ts)",
  });
  assert.ok(accesses.length > 0);

  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const warnings: string[] = [];
  const forbiddenPiAccesses: PropertyKey[] = [];
  const fakePi = new Proxy({
    registerCommand() {},
    registerTool() {},
    getCommands: () => commands,
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) { handlers.set(event, handler); },
  }, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      forbiddenPiAccesses.push(property);
      throw new Error(`forbidden host access: ${String(property)}`);
    },
  }) as unknown as ExtensionAPI;
  let runtimeFactoryCalls = 0;
  const filesystemAndStoreRuntimeTrap = new Proxy((): never => {
    runtimeFactoryCalls++;
    throw new Error("conflict path must not construct the presenter or store runtime");
  }, {
    apply(target, thisArg, argumentsList) {
      runtimeFactoryCalls++;
      return Reflect.apply(target, thisArg, argumentsList);
    },
  });
  registerFrontierAutoresearch(fakePi, filesystemAndStoreRuntimeTrap);
  const forbiddenContextAccesses: PropertyKey[] = [];
  const context = new Proxy({
    mode: "tui" as const,
    ui: {
      notify(message: string, level: string) { if (level === "warning") warnings.push(message); },
    },
  }, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      forbiddenContextAccesses.push(property);
      throw new Error(`forbidden context access: ${String(property)}`);
    },
  });

  await handlers.get("session_start")?.({}, context);
  assert.equal(runtimeFactoryCalls, 0, "conflict handling cannot construct a presenter or store runtime");
  assert.deepEqual(forbiddenPiAccesses, []);
  assert.deepEqual(forbiddenContextAccesses, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /pi-frontier-autoresearch/);
  assert.match(warnings[0] ?? "", /\/packages\/pi-frontier-autoresearch\/extensions\/pi-frontier-autoresearch\/index\.ts/);
  assert.match(warnings[0] ?? "", /pi-autoresearch/);
  assert.match(warnings[0] ?? "", /\/packages\/pi-autoresearch\/index\.ts/);
  assert.deepEqual({
    content: await readFile(join(legacy, "legacy-state.json"), "utf8"),
    mode: (await stat(legacy)).mode,
    modified: (await stat(legacy)).mtimeMs,
  }, before);
});

test("command conflict warning deduplicates extension reloads per Pi host", async () => {
  const commands = [
    { name: "autoresearch:1", source: "extension", sourceInfo: { path: "/packages/pi-autoresearch/index.ts", source: "pi-autoresearch" } },
    { name: "autoresearch:2", source: "extension", sourceInfo: { path: "/packages/pi-frontier-autoresearch/index.ts", source: "pi-frontier-autoresearch" } },
  ];
  const host = () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
    const warnings: string[] = [];
    const pi = {
      registerCommand() {},
      registerTool() {},
      getCommands: () => commands,
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) { handlers.set(event, handler); },
    } as unknown as ExtensionAPI;
    const context = {
      mode: "tui",
      ui: { notify(message: string, level: string) { if (level === "warning") warnings.push(message); } },
    };
    return { pi, handlers, warnings, context };
  };

  const firstHost = host();
  frontierAutoresearch(firstHost.pi);
  await firstHost.handlers.get("session_start")?.({}, firstHost.context);
  frontierAutoresearch(firstHost.pi);
  await firstHost.handlers.get("session_start")?.({}, firstHost.context);
  assert.equal(firstHost.warnings.length, 1, "two extension registrations on one host warn once");

  const secondHost = host();
  frontierAutoresearch(secondHost.pi);
  await secondHost.handlers.get("session_start")?.({}, secondHost.context);
  assert.equal(secondHost.warnings.length, 1, "a distinct host can warn independently");
});

test("non-TUI prompt, configure, lifecycle, status, and error paths use text or events without UI calls", async (t) => {
  for (const mode of ["print", "json", "rpc"] as const) {
    const harness = extensionHarness();
    frontierAutoresearch(harness.pi);
    const uiCalls: string[] = [];
    const context = {
      mode,
      cwd: await repository(t, `frontier-non-tui-${mode}-`),
      hasUI: mode === "rpc",
      ui: {
        notify() { uiCalls.push("notify"); },
        setWidget() { uiCalls.push("setWidget"); },
        setStatus() { uiCalls.push("setStatus"); },
      },
    };
    let printed = "";
    const originalWrite = process.stdout.write;
    if (mode === "print") {
      process.stdout.write = ((chunk: string | Uint8Array) => {
        printed += String(chunk);
        return true;
      }) as typeof process.stdout.write;
    }
    try {
      await harness.handlers.get("session_start")?.({}, context);
      await harness.commands.get("autoresearch-prompt")?.handler("", context);
      await harness.commands.get("autoresearch-prompt")?.handler("reduce build time", context);
      assert.equal(harness.sentUsers.at(-1), "/skill:autoresearch-setup reduce build time", mode);

      const configure = harness.tools.get("autoresearch_configure");
      assert.ok(configure, mode);
      await assert.rejects(
        configure.execute("bad-config", { config: "{" }, undefined, undefined, context),
        /Configuration must be valid JSON/,
        mode,
      );
      const configured = await configure.execute(
        "good-config",
        { config: JSON.stringify(configSpec(context.cwd)) },
        undefined,
        undefined,
        context,
      );
      assert.match(configured?.content[0]?.text ?? "", /Run configured\./, mode);
      await harness.commands.get("autoresearch")?.handler("status", context);

      const actionStates: Array<readonly [string, RunState["status"]]> = [
        ["start", "configured"],
        ["pause", "pausing"],
        ["resume", "paused"],
        ["stop", "stopping"],
        ["clear confirm", "completed"],
      ];
      for (const [action, status] of actionStates) {
        const actionRoot = await repository(t, `frontier-${mode}-${action.replaceAll(" ", "-")}-`);
        await writeActionState(actionRoot, status, `${mode}-${action.replaceAll(" ", "-")}`);
        await harness.commands.get("autoresearch")?.handler(action, { ...context, cwd: actionRoot });
      }
      const missingRoot = await repository(t, `frontier-${mode}-missing-`);
      await harness.commands.get("autoresearch")?.handler("status", { ...context, cwd: missingRoot });
    } finally {
      process.stdout.write = originalWrite;
    }

    const surfaced = mode === "print" ? printed : harness.sentMessages.join("\n");
    assert.match(surfaced, /Add a mechanical optimisation goal/, mode);
    assert.match(surfaced, /Run non-tui-config: configured/, mode);
    for (const action of ["start", "pause", "resume", "stop"] as const) {
      assert.match(surfaced, new RegExp(`Run ${mode}-${action}:`), mode);
    }
    assert.match(surfaced, /Run history cleared\./, mode);
    assert.match(surfaced, /Autoresearch command failed: No configured frontier autoresearch run was found\./, mode);
    assert.deepEqual(uiCalls, [], mode);
    await harness.handlers.get("session_shutdown")?.({}, context);
  }
});
