import assert from "node:assert/strict";
import test from "node:test";

import {
  FrontierController,
  initialPolicyVersion,
  type Assignment,
  type Evaluation,
  type FrontierEvent,
  type FrontierPolicy,
  type MetricSummary,
  type NodeRecord,
} from "../src/index.ts";

const policy: FrontierPolicy = {
  size: 4,
  leanPrimaryTolerance: 0.03,
  diversePrimaryTolerance: 0.05,
  diverseNoveltyThreshold: 0.5,
  crossoverCadence: 3,
};

function assignmentParentIds(assignment: Assignment): string[] {
  return [assignment.primaryParentId, assignment.donorParentId]
    .filter((parentId): parentId is string => parentId !== undefined);
}

function node(
  id: string,
  binding: "baseline" | Assignment,
  changedFiles: readonly string[],
  changedLines: number,
  outcome: NodeRecord["outcome"] = "pending",
): NodeRecord {
  return {
    id,
    commit: `${id}-commit`,
    ref: `refs/autoresearch/nodes/${id}`,
    parentIds: binding === "baseline" ? [] : assignmentParentIds(binding),
    operator: binding === "baseline" ? "baseline" : binding.operator,
    hypothesis: `Try ${id}`,
    reflection: "",
    diffSummary: { changedFiles, changedLines },
    metricSamples: {},
    guardResults: [],
    outcome,
    policyVersion: 1,
    createdEventIndex: 0,
    selection: { attempts: 0, promotions: 0 },
  };
}

type CandidateFactory = (assignment: Assignment) => NodeRecord;

function candidate(
  id: string,
  changedFiles: readonly string[],
  changedLines: number,
  outcome: NodeRecord["outcome"] = "pending",
): CandidateFactory {
  return (assignment) => node(id, assignment, changedFiles, changedLines, outcome);
}

function evaluation(
  nodeId: string,
  score: number,
  options: { confirmed?: boolean; passed?: boolean; cost?: number } = {},
): Evaluation {
  const passed = options.passed ?? true;
  const samples: Record<string, readonly number[]> = { score: [score] };
  const summaries: Record<string, MetricSummary> = {
    score: { median: score, medianAbsoluteDeviation: 0, minimum: score, maximum: score },
  };
  if (options.cost !== undefined) {
    samples.cost = [options.cost];
    summaries.cost = {
      median: options.cost,
      medianAbsoluteDeviation: 0,
      minimum: options.cost,
      maximum: options.cost,
    };
  }
  return {
    nodeId,
    samples,
    summaries,
    guards: [{ name: "correctness", status: passed ? "passed" : "failed" }],
    protectedPathsIntact: passed,
    scopeValid: passed,
    confirmationAttempted: true,
    confirmed: options.confirmed ?? true,
    reason: passed ? "confirmed" : "correctness failed",
  };
}

function controller(overrides: Partial<import("../src/index.ts").FrontierControllerConfig> = {}) {
  return new FrontierController({
    primaryMetric: "score",
    primaryDirection: "higher",
    policy,
    ...overrides,
  });
}

function record(
  frontier: FrontierController,
  history: readonly FrontierEvent[],
  candidateInput: NodeRecord | CandidateFactory,
  score?: number,
  options?: { confirmed?: boolean; passed?: boolean; cost?: number },
): { history: FrontierEvent[]; event: Extract<FrontierEvent, { type: "evaluation-recorded" }> } {
  const prepared = history.length === 0 ? [frontier.recordPolicy()] : [...history];
  let candidateNode: NodeRecord;
  if (typeof candidateInput === "function") {
    if (!frontier.replay(prepared).activeAssignment) {
      prepared.push(frontier.nextAssignment(prepared, { experimentId: `assignment-${prepared.length}` }));
    }
    const assignment = frontier.replay(prepared).activeAssignment!;
    candidateNode = candidateInput(assignment);
    assert.equal(candidateNode.operator, assignment.operator);
    assert.deepEqual(candidateNode.parentIds, assignmentParentIds(assignment));
  } else {
    candidateNode = candidateInput;
    assert.equal(candidateNode.operator, "baseline");
    assert.deepEqual(candidateNode.parentIds, []);
  }
  const event = frontier.recordEvaluation(prepared, {
    node: candidateNode,
    evaluation: score === undefined ? undefined : evaluation(candidateNode.id, score, options),
  });
  return { history: [...prepared, event], event };
}

function add(
  frontier: FrontierController,
  history: readonly FrontierEvent[],
  candidateInput: NodeRecord | CandidateFactory,
  score?: number,
  options?: { confirmed?: boolean; passed?: boolean; cost?: number },
): FrontierEvent[] {
  return record(frontier, history, candidateInput, score, options).history;
}

function closeFailedAssignment(
  frontier: FrontierController,
  history: readonly FrontierEvent[],
  assignment: Extract<FrontierEvent, { type: "assignment-recorded" }>,
  id: string,
): FrontierEvent[] {
  return add(frontier, history, (binding) => {
    assert.deepEqual(binding, assignment.assignment);
    return node(id, binding, [], 0, "failed");
  });
}

test("promotion gate previews guard-valid initial evidence without changing replay history", () => {
  const frontier = controller();
  let history: FrontierEvent[] = [];
  history = add(frontier, history, node("preview-root", "baseline", ["src/root.ts"], 10), 100);
  const assignment = frontier.nextAssignment(history, { experimentId: "preview-assignment" });
  history.push(assignment);
  const candidateNode = node("preview-candidate", assignment.assignment, ["src/candidate.ts"], 1);
  const initial = evaluation(candidateNode.id, 101, { confirmed: false });
  const before = structuredClone(history);

  const gate = frontier.createPromotionGate(history);
  assert.equal(gate({ candidate: candidateNode, initialEvaluation: initial }), "BEST");
  assert.equal(gate({
    candidate: candidateNode,
    initialEvaluation: { ...initial, guards: [{ name: "correctness", status: "failed" }] },
  }), undefined);
  assert.deepEqual(history, before);
  assert.equal(frontier.recordEvaluation(history, { node: candidateNode, evaluation: initial }).decision.promoted, false);
});

test("frontier promotion recalculates unique BEST, LEAN, and DIVERSE roles", () => {
  const frontier = controller({ costMetric: "cost", costDirection: "lower" });
  let history: FrontierEvent[] = [];
  history = add(frontier, history, node("root", "baseline", ["src/root.ts"], 100), 100, { cost: 100 });
  history = add(frontier, history, candidate("best", ["src/fast.ts"], 80), 105, { cost: 90 });
  history = add(frontier, history, candidate("lean", ["src/fast.ts"], 200), 103, { cost: 50 });
  history = add(frontier, history, candidate("diverse", ["src/alternate.ts"], 60), 101, { cost: 120 });
  history = add(frontier, history, candidate("other", ["src/other.ts"], 50), 100.5, { cost: 110 });

  const snapshot = frontier.replay(history);
  assert.equal(snapshot.frontier.length, 4);
  assert.equal(new Set(snapshot.frontier.map((slot) => slot.nodeId)).size, 4);
  assert.deepEqual(snapshot.frontier.slice(0, 2).map(({ role, nodeId }) => ({ role, nodeId })), [
    { role: "BEST", nodeId: "best" },
    { role: "LEAN", nodeId: "lean" },
  ]);

  const bestScore = snapshot.evaluations[snapshot.frontier[0]!.nodeId]!.summaries.score!.median;
  assert.equal(bestScore, 105);
  const leanSlot = snapshot.frontier.find((slot) => slot.role === "LEAN");
  assert.ok(leanSlot);
  assert.equal(snapshot.evaluations[leanSlot.nodeId]!.summaries.cost!.median, 50);
  assert.equal(snapshot.nodes[leanSlot.nodeId]!.diffSummary.changedLines, 200);
  assert.ok(snapshot.frontier.some((slot) => slot.role === "DIVERSE" && slot.nodeId === "diverse"));
});

test("frontier promotion honours lower-is-better primary metrics", () => {
  const frontier = new FrontierController({
    primaryMetric: "score",
    primaryDirection: "lower",
    policy,
  });
  let history: FrontierEvent[] = [];
  history = add(frontier, history, node("root", "baseline", ["src/root.ts"], 100), 100);
  history = add(frontier, history, candidate("best-low", ["src/fast.ts"], 80), 90);
  history = add(frontier, history, candidate("lean-low", ["src/fast.ts"], 20), 91);
  history = add(frontier, history, candidate("diverse-low", ["src/alternate.ts"], 90), 94);

  assert.deepEqual(frontier.replay(history).frontier.map(({ role, nodeId }) => ({ role, nodeId })), [
    { role: "BEST", nodeId: "best-low" },
    { role: "LEAN", nodeId: "lean-low" },
    { role: "DIVERSE", nodeId: "diverse-low" },
  ]);
});

test("selection rotates parents and schedules crossover at the configured cadence", () => {
  const frontier = controller();
  let history: FrontierEvent[] = [];
  for (const [candidateInput, score] of [
    [node("root", "baseline", ["src/root.ts"], 10), 100],
    [candidate("alpha", ["src/alpha.ts"], 30), 99],
    [candidate("beta", ["src/beta.ts"], 30), 98],
    [candidate("gamma", ["src/gamma.ts"], 30), 97],
  ] as const) {
    history = add(frontier, history, candidateInput, score);
  }

  const first = frontier.nextAssignment(history, { experimentId: "e-1" });
  assert.equal(first.assignment.operator, "mutation");
  history.push(first);
  history = closeFailedAssignment(frontier, history, first, "failed-1");
  const second = frontier.nextAssignment(history, { experimentId: "e-2" });
  assert.equal(second.assignment.operator, "mutation");
  assert.notEqual(second.assignment.primaryParentId, first.assignment.primaryParentId);
  history.push(second);
  history = closeFailedAssignment(frontier, history, second, "failed-2");
  const third = frontier.nextAssignment(history, { experimentId: "e-3" });
  assert.equal(third.assignment.operator, "crossover");
  assert.ok(third.assignment.donorParentId);
  assert.notEqual(third.assignment.primaryParentId, third.assignment.donorParentId);
  assert.ok(third.scores.every((score) => Object.values(score).every((value) => typeof value === "string" || Number.isFinite(value))));
});

test("long schedules preserve crossover cadence and rotate both parent roles", () => {
  const frontier = controller();
  let history: FrontierEvent[] = [];
  for (const [candidateInput, score] of [
    [node("long-root", "baseline", ["src/root.ts"], 10), 100],
    [candidate("long-alpha", ["src/alpha.ts"], 30), 99],
    [candidate("long-beta", ["src/beta.ts"], 30), 98],
    [candidate("long-gamma", ["src/gamma.ts"], 30), 97],
  ] as const) history = add(frontier, history, candidateInput, score);

  const scheduled: Extract<FrontierEvent, { type: "assignment-recorded" }>[] = [];
  for (let index = 0; index < 18; index += 1) {
    const assignment = frontier.nextAssignment(history, { experimentId: `long-${index}` });
    scheduled.push(assignment);
    history.push(assignment);
    history = add(
      frontier,
      history,
      (binding) => {
        assert.deepEqual(binding, assignment.assignment);
        return node(`long-failed-${index}`, binding, [`src/direction-${index % 4}.ts`], 1, "failed");
      },
    );
  }

  const crossoverIndexes = scheduled
    .map((event, index) => event.assignment.operator === "crossover" ? index : -1)
    .filter((index) => index >= 0);
  assert.ok(crossoverIndexes.length >= 6);
  assert.ok(crossoverIndexes.slice(1).every((index, offset) => index - crossoverIndexes[offset]! <= policy.crossoverCadence));
  const crossovers = scheduled.filter((event) => event.assignment.operator === "crossover");
  assert.ok(new Set(crossovers.map((event) => event.assignment.primaryParentId)).size > 1);
  assert.ok(new Set(crossovers.map((event) => event.assignment.donorParentId)).size > 1);

  const next = frontier.nextAssignment(history, { experimentId: "coverage-check" });
  const directions = new Map<string, Set<string>>();
  const childCounts = new Map<string, number>();
  for (const event of history) {
    if (event.type !== "evaluation-recorded" || event.node.operator === "baseline") continue;
    const direction = [...new Set(event.node.diffSummary.changedFiles)].sort().join("\u0000");
    if (!direction) continue;
    for (const parentId of event.node.parentIds) {
      (directions.get(parentId) ?? directions.set(parentId, new Set()).get(parentId)!).add(direction);
      childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
    }
  }
  assert.ok([...childCounts].some(([parentId, count]) => count > (directions.get(parentId)?.size ?? 0)));
  for (const score of next.scores) {
    assert.equal(score.coverage, 1 / (1 + (directions.get(score.nodeId)?.size ?? 0)));
  }
});

test("selection events replay UCB productivity statistics", () => {
  const frontier = controller();
  let history: FrontierEvent[] = [];
  history = add(frontier, history, node("root", "baseline", ["src/root.ts"], 100), 100);
  history = add(frontier, history, candidate("alternate", ["src/alternate.ts"], 100), 98);
  const assignment = frontier.nextAssignment(history, { experimentId: "productive" });
  history.push(assignment);
  const parents = assignmentParentIds(assignment.assignment);
  const successfulNode = node("successful-child", assignment.assignment, ["src/improved.ts"], 80);
  assert.equal(successfulNode.operator, assignment.assignment.operator);
  assert.deepEqual(successfulNode.parentIds, parents);
  const successful = frontier.recordEvaluation(history, {
    node: successfulNode,
    evaluation: evaluation("successful-child", 101),
  });
  history.push(successful);

  const snapshot = frontier.replay(history);
  for (const parentId of parents) {
    assert.deepEqual(snapshot.statistics[parentId], {
      attempts: 1,
      promotions: 1,
      lastSelectedEventIndex: assignment.index,
    });
    assert.deepEqual(snapshot.nodes[parentId]!.selection, snapshot.statistics[parentId]);
  }
  const next = frontier.nextAssignment(history, { experimentId: "after-success" });
  assert.ok(next.scores.every((score) => Number.isFinite(score.exploration)));
  assert.ok(next.scores.find((score) => score.nodeId === parents[0])!.productivity === 1);
});

test("selection crosses a fresh BEST with a complementary parent", () => {
  const frontier = controller({ policy: { ...policy, crossoverCadence: 10 } });
  let history: FrontierEvent[] = [];
  history = add(frontier, history, node("root", "baseline", ["src/root.ts"], 10), 100);
  history = add(frontier, history, candidate("diverse", ["src/alternate.ts"], 30), 98);
  const beforeElite = frontier.nextAssignment(history, { experimentId: "before-elite" });
  history.push(beforeElite);
  history = closeFailedAssignment(frontier, history, beforeElite, "before-elite-failed");
  history = add(frontier, history, candidate("elite", ["src/elite.ts"], 20), 104);

  const assignment = frontier.nextAssignment(history, { experimentId: "fresh-elite" });
  assert.equal(assignment.assignment.operator, "crossover");
  assert.equal(assignment.assignment.primaryParentId, "elite");
  assert.ok(["root", "diverse"].includes(assignment.assignment.donorParentId!));
  assert.match(assignment.reason, /fresh BEST/);
});

test("crossover pair penalties rotate repeated pairs deterministically", () => {
  const frontier = controller({ policy: { ...policy, crossoverCadence: 1 } });
  let history: FrontierEvent[] = [];
  for (const [candidateInput, score] of [
    [node("root", "baseline", ["src/root.ts"], 10), 100],
    [candidate("alpha", ["src/alpha.ts"], 30), 99],
    [candidate("beta", ["src/beta.ts"], 30), 98],
    [candidate("gamma", ["src/gamma.ts"], 30), 97],
  ] as const) {
    history = add(frontier, history, candidateInput, score);
  }

  const first = frontier.nextAssignment(history, { experimentId: "pair-1" });
  history.push(first);
  history = closeFailedAssignment(frontier, history, first, "pair-1-failed");
  const second = frontier.nextAssignment(history, { experimentId: "pair-2" });
  const firstPair = [first.assignment.primaryParentId, first.assignment.donorParentId].sort();
  const secondPair = [second.assignment.primaryParentId, second.assignment.donorParentId].sort();
  assert.notDeepEqual(secondPair, firstPair);
  assert.notEqual(second.assignment.primaryParentId, first.assignment.primaryParentId);
  assert.deepEqual(
    frontier.nextAssignment(history, { experimentId: "pair-2" }),
    frontier.nextAssignment(structuredClone(history), { experimentId: "pair-2" }),
  );
});

test("promotion enforces LEAN cost and DIVERSE fitness and novelty bounds", () => {
  const frontier = controller();
  let history: FrontierEvent[] = [];
  history = add(frontier, history, node("root", "baseline", ["src/core.ts"], 100), 100);

  for (const [candidateInput, score] of [
    [candidate("outside-lean", ["src/core.ts"], 10), 96],
    [candidate("same-direction", ["src/core.ts"], 120), 98],
    [candidate("outside-diverse", ["src/alternate.ts"], 120), 94],
  ] as const) {
    const recorded = record(frontier, history, candidateInput, score);
    assert.equal(recorded.event.decision.promoted, false);
    history = recorded.history;
  }

  const leanRecorded = record(frontier, history, candidate("lean-valid", ["src/core.ts"], 50), 98);
  const lean = leanRecorded.event;
  history = leanRecorded.history;
  assert.deepEqual({ promoted: lean.decision.promoted, role: lean.decision.role }, { promoted: true, role: "LEAN" });

  const diverseRecorded = record(frontier, history, candidate("diverse-valid", ["src/alternate.ts"], 120), 96);
  const diverse = diverseRecorded.event;
  history = diverseRecorded.history;
  assert.deepEqual({ promoted: diverse.decision.promoted, role: diverse.decision.role }, { promoted: true, role: "DIVERSE" });
  assert.ok(diverse.decision.novelty >= policy.diverseNoveltyThreshold);
  assert.ok(evaluation("bound", 96).summaries.score!.median >= 100 * (1 - policy.diversePrimaryTolerance));
});

test("recordEvaluation rejects parentage and operator that mismatch the binding assignment", () => {
  const frontier = controller();
  let history: FrontierEvent[] = [];
  history = add(frontier, history, node("root", "baseline", ["src/root.ts"], 10), 100);
  const assignment = frontier.nextAssignment(history, { experimentId: "bound" });
  history.push(assignment);

  const wrongParent = {
    ...node("wrong-parent", assignment.assignment, ["src/change.ts"], 2),
    parentIds: ["other"],
  };
  assert.throws(
    () => frontier.recordEvaluation(history, {
      node: wrongParent,
      evaluation: evaluation(wrongParent.id, 101),
    }),
    /does not match assignment bound/,
  );

  const wrongOperator: NodeRecord = {
    ...node("wrong-operator", assignment.assignment, ["src/change.ts"], 2),
    operator: assignment.assignment.operator === "mutation" ? "crossover" : "mutation",
  };
  assert.throws(
    () => frontier.recordEvaluation(history, {
      node: wrongOperator,
      evaluation: evaluation(wrongOperator.id, 101),
    }),
    /does not match assignment bound/,
  );
});

test("generated event histories preserve frontier, lineage, role, and event-index invariants", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const frontier = controller({ policy: { ...policy, crossoverCadence: 4 } });
    let random = seed;
    const nextRandom = () => {
      random = (random * 48_271) % 2_147_483_647;
      return random;
    };
    let history: FrontierEvent[] = [];
    history = add(frontier, history, node(`root-${seed}`, "baseline", ["src/root.ts"], 100), 100);

    for (let iteration = 0; iteration < 25; iteration += 1) {
      const before = frontier.replay(history);
      const assignment = frontier.nextAssignment(history, { experimentId: `s${seed}-e${iteration}` });
      assert.equal(assignment.index, history.at(-1)!.index + 1);
      assert.ok(before.nodes[assignment.assignment.primaryParentId]);
      if (assignment.assignment.donorParentId) assert.ok(before.nodes[assignment.assignment.donorParentId]);
      history.push(assignment);

      const parentIds = assignmentParentIds(assignment.assignment);
      const id = `s${seed}-n${iteration}`;
      const crashed = nextRandom() % 9 === 0;
      const candidateNode = node(
        id,
        assignment.assignment,
        [`src/branch-${nextRandom() % 7}.ts`],
        10 + nextRandom() % 100,
        crashed ? "failed" : "pending",
      );
      assert.equal(candidateNode.operator, assignment.assignment.operator);
      assert.deepEqual(candidateNode.parentIds, parentIds);
      const event = frontier.recordEvaluation(history, {
        node: candidateNode,
        evaluation: crashed ? undefined : evaluation(id, 95 + nextRandom() % 11, {
          passed: nextRandom() % 8 !== 0,
          confirmed: nextRandom() % 7 !== 0,
        }),
      });
      history.push(event);

      const snapshot = frontier.replay(history);
      assert.equal(event.node.createdEventIndex, event.index);
      assert.ok(snapshot.frontier.length <= 4);
      assert.equal(new Set(snapshot.frontier.map((slot) => slot.nodeId)).size, snapshot.frontier.length);
      assert.equal(snapshot.frontier[0]?.role, "BEST");
      assert.ok(snapshot.frontier.slice(1).every((slot) => slot.role !== "BEST"));
      assert.ok(Object.values(snapshot.statistics).every((statistics) => statistics.promotions <= statistics.attempts));
      for (const parentId of event.node.parentIds) assert.ok(before.nodes[parentId]);
      const frontierScores = snapshot.frontier.map(
        (slot) => snapshot.evaluations[slot.nodeId]!.summaries.score!.median,
      );
      assert.equal(frontierScores[0], Math.max(...frontierScores));
    }

    assert.deepEqual(frontier.replay(history), frontier.replay(JSON.parse(JSON.stringify(history)) as FrontierEvent[]));
    const malformed = structuredClone(history);
    malformed.at(-1)!.index = malformed.at(-2)!.index;
    assert.throws(() => frontier.replay(malformed), /indexes must increase monotonically/);
  }
});

test("fixed policy and assignment bindings are authoritative during replay", () => {
  const frontier = controller({ weights: { coverage: 0.75 } });
  const policyEvent = frontier.recordPolicy();
  let history: FrontierEvent[] = [policyEvent];
  history = add(frontier, history, node("bound-root", "baseline", ["src/root.ts"], 10), 100);
  const arbitraryMutation: Assignment = {
    experimentId: "arbitrary-mutation",
    operator: "mutation",
    primaryParentId: "bound-root",
    hypothesis: "not controller assigned",
    policyVersion: 1,
  };
  const arbitraryCrossover: Assignment = {
    ...arbitraryMutation,
    experimentId: "arbitrary-crossover",
    operator: "crossover",
    donorParentId: "fabricated-parent",
  };

  assert.throws(
    () => frontier.recordEvaluation(history, {
      node: node("arbitrary-mutation", arbitraryMutation, ["src/arbitrary.ts"], 2),
      evaluation: evaluation("arbitrary-mutation", 101),
    }),
    /requires a pending assignment/,
  );
  assert.throws(
    () => frontier.recordEvaluation(history, {
      node: node("arbitrary-crossover", arbitraryCrossover, ["src/arbitrary.ts"], 2),
      evaluation: evaluation("arbitrary-crossover", 101),
    }),
    /requires a pending assignment/,
  );

  const wrongPolicy = structuredClone(history);
  const recordedPolicy = wrongPolicy[0];
  assert.equal(recordedPolicy?.type, "policy-recorded");
  if (recordedPolicy?.type === "policy-recorded") recordedPolicy.policy.weights.coverage = 0.25;
  assert.throws(() => frontier.replay(wrongPolicy), /does not match the active controller policy/);

  const assignmentHistory = [...history, frontier.nextAssignment(history, { experimentId: "wrong-version" })];
  const wrongVersion = structuredClone(assignmentHistory);
  const assignmentEvent = wrongVersion.at(-1);
  assert.equal(assignmentEvent?.type, "assignment-recorded");
  if (assignmentEvent?.type === "assignment-recorded") assignmentEvent.assignment.policyVersion = 2;
  assert.throws(() => frontier.replay(wrongVersion), /inactive policy version/);
});

test("replay rejects fabricated locally valid frontier transitions and decisions", () => {
  const frontier = controller();
  let history: FrontierEvent[] = [frontier.recordPolicy()];
  history = add(frontier, history, node("replay-root", "baseline", ["src/root.ts"], 100), 100);
  const assignment = frontier.nextAssignment(history, { experimentId: "replay-bound" });
  history.push(assignment);
  const candidateNode = node("replay-best", assignment.assignment, ["src/best.ts"], 50);
  assert.equal(candidateNode.operator, assignment.assignment.operator);
  assert.deepEqual(candidateNode.parentIds, assignmentParentIds(assignment.assignment));
  history.push(frontier.recordEvaluation(history, {
    node: candidateNode,
    evaluation: evaluation(candidateNode.id, 105),
  }));

  const fabricated = structuredClone(history);
  const final = fabricated.at(-1);
  assert.equal(final?.type, "evaluation-recorded");
  if (final?.type === "evaluation-recorded") {
    final.frontier = [{ index: 0, role: "BEST", nodeId: "replay-root" }];
    final.decision = { promoted: false, reason: "candidate did not improve a frontier role", novelty: 1 };
  }
  assert.throws(() => frontier.replay(fabricated), /frontier transition does not match derived transition/);

  const falseRole = structuredClone(history);
  const falseRoleFinal = falseRole.at(-1);
  if (falseRoleFinal?.type === "evaluation-recorded") falseRoleFinal.decision.role = "LEAN";
  assert.throws(() => frontier.replay(falseRole), /decision does not match derived transition/);
});

test("replay verifies persisted roles under the policy that derived their transition", () => {
  const versionOne = initialPolicyVersion(policy);
  const versionTwo = {
    version: 2,
    frontier: { ...policy, diversePrimaryTolerance: 0 },
    weights: { ...versionOne.weights },
  };
  const frontier = controller({ policyVersions: [versionOne, versionTwo] });
  let history: FrontierEvent[] = [];
  history = add(frontier, history, node("policy-root", "baseline", ["src/root.ts"], 10), 100);
  const versionOneAssignment = frontier.nextAssignment(history, { experimentId: "policy-one", policyVersion: 1 });
  history.push(versionOneAssignment);
  const near = node("policy-near", versionOneAssignment.assignment, ["src/near.ts"], 20);
  history.push(frontier.recordEvaluation(history, { node: near, evaluation: evaluation(near.id, 98) }));
  assert.deepEqual(frontier.replay(history).frontier, [
    { index: 0, role: "BEST", nodeId: "policy-root" },
    { index: 1, role: "DIVERSE", nodeId: "policy-near" },
  ]);

  // Policy version two is active for this pending assignment, but has not yet
  // derived a transition. Replay must retain and verify version one's slots.
  history.push(frontier.nextAssignment(history, { experimentId: "policy-two", policyVersion: 2 }));
  assert.deepEqual(frontier.replay(history).frontier, [
    { index: 0, role: "BEST", nodeId: "policy-root" },
    { index: 1, role: "DIVERSE", nodeId: "policy-near" },
  ]);

  const tampered = structuredClone(history);
  const transition = tampered.at(-2);
  assert.equal(transition?.type, "evaluation-recorded");
  if (transition?.type === "evaluation-recorded") {
    transition.frontier = [{ index: 0, role: "BEST", nodeId: "policy-root" }];
  }
  assert.throws(() => frontier.replay(tampered), /frontier transition does not match derived transition/);
});

test("failed, unconfirmed, and crashed nodes stay in lineage but never enter the frontier", () => {
  const frontier = controller();
  let history: FrontierEvent[] = [];
  history = add(frontier, history, node("root", "baseline", ["src/root.ts"], 100), 100);

  const failedGuardRecorded = record(
    frontier,
    history,
    candidate("failed-guard", ["src/unsafe.ts"], 1),
    200,
    { passed: false },
  );
  const failedGuard = failedGuardRecorded.event;
  history = failedGuardRecorded.history;
  history = record(
    frontier,
    history,
    candidate("unconfirmed", ["src/lucky.ts"], 1),
    200,
    { confirmed: false },
  ).history;
  history = add(frontier, history, candidate("already-rejected", ["src/rejected.ts"], 1, "rejected"));
  history = add(frontier, history, candidate("crashed", [], 0, "failed"));

  const snapshot = frontier.replay(history);
  assert.deepEqual(Object.keys(snapshot.nodes).sort(), ["already-rejected", "crashed", "failed-guard", "root", "unconfirmed"]);
  assert.deepEqual(snapshot.frontier.map((slot) => slot.nodeId), ["root"]);
  assert.equal(snapshot.nodes["already-rejected"]!.outcome, "rejected");
  assert.equal(snapshot.nodes["failed-guard"]!.outcome, "rejected");
  assert.equal(snapshot.nodes["unconfirmed"]!.outcome, "rejected");
  assert.equal(snapshot.nodes["crashed"]!.outcome, "failed");
});
