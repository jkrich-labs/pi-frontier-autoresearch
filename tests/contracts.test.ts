import assert from "node:assert/strict";
import test from "node:test";

import {
  ManualClock,
  assertRunSpec,
  validateRunSpec,
  type RunSpec,
} from "../src/index.ts";

const validRunSpec: RunSpec = {
  schemaVersion: 1,
  runId: "build-time",
  targetRepository: "/tmp/example",
  objective: "Reduce build time without changing output",
  primaryMetric: "build_ms",
  metrics: [{ name: "build_ms", direction: "lower" }],
  evaluator: {
    command: "./bench.sh",
    timeoutMs: 30_000,
  },
  editableGlobs: ["src/**"],
  protectedPaths: ["bench.sh", "tests/fixtures"],
  probes: [],
  guards: [],
  budget: { maxExperiments: 20 },
  baseline: { samples: 5 },
  confirmation: { maxSamples: 7, confidenceMultiplier: 2 },
  frontierPolicy: {
    size: 4,
    leanPrimaryTolerance: 0.02,
    diversePrimaryTolerance: 0.05,
    diverseNoveltyThreshold: 0.35,
    crossoverCadence: 4,
  },
};

test("package exports validate the authoritative run contract", () => {
  assert.deepEqual(validateRunSpec(validRunSpec), []);
  assert.doesNotThrow(() => assertRunSpec(validRunSpec));

  const invalid = {
    ...validRunSpec,
    primaryMetric: "missing",
    budget: {},
  };
  assert.deepEqual(validateRunSpec(invalid), [
    "budget must set a finite limit or explicitly allow unlimited execution",
    'primary metric "missing" is not declared',
  ]);
  assert.throws(() => assertRunSpec(invalid), /Run spec is invalid/);
});

test("contract validation rejects malformed nested run settings", () => {
  const invalid = structuredClone(validRunSpec) as unknown as Record<string, unknown>;
  invalid.budget = { maxExperiments: -1, maxWallTimeMs: 1_000 };
  invalid.editableGlobs = ["", 3];
  invalid.protectedPaths = [false];
  invalid.probes = [{ name: "syntax", description: "", command: "", timeoutMs: 0 }];
  invalid.guards = [{ type: "metric", metric: "unknown" }];
  invalid.baseline = { samples: 1.5 };
  invalid.confirmation = { maxSamples: 2.5, confidenceMultiplier: 0 };
  invalid.frontierPolicy = {
    size: 4,
    leanPrimaryTolerance: -1,
    diversePrimaryTolerance: -1,
    diverseNoveltyThreshold: 2,
    crossoverCadence: 0,
  };

  const issues = validateRunSpec(invalid);
  for (const expected of [
    "budget maxExperiments must be a positive integer",
    "editableGlobs must contain only non-empty strings",
    "protectedPaths must contain only non-empty strings",
    'probe "syntax" must have a non-empty description',
    'metric guard references undeclared metric "unknown"',
    "baseline samples must be a positive integer",
    "confirmation maxSamples must be a positive integer",
    "confirmation confidenceMultiplier must be positive",
    "frontier policy leanPrimaryTolerance must be between 0 and 1",
    "frontier policy diversePrimaryTolerance must be between 0 and 1",
    "frontier policy diverseNoveltyThreshold must be between 0 and 1",
    "frontier policy crossoverCadence must be a positive integer",
  ]) {
    assert.ok(issues.includes(expected), `missing issue: ${expected}`);
  }
});

test("manual clock advances deterministically", () => {
  const clock = new ManualClock(1_000);
  assert.equal(clock.now(), 1_000);
  clock.advance(250);
  assert.equal(clock.now(), 1_250);
});
