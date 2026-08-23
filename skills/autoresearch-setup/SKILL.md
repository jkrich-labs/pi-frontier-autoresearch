---
name: autoresearch-setup
description: Turn a rough codebase optimisation goal into a validated frontier autoresearch run. Use only when the user invokes autoresearch setup.
disable-model-invocation: true
---

# Set up frontier autoresearch

Turn the user's rough goal into one mechanical run configuration. Configuration and baseline calibration do not start experiments.

1. Inspect the target Git repository. Identify its build, test, benchmark, and correctness commands without changing tracked files.
2. Restate the objective as one measurable outcome. Ask only for decisions the repository cannot answer.
3. Define one primary `METRIC name=value` result and its `higher` or `lower` direction. Add secondary metrics only when they constrain the goal.
4. Choose the smallest editable glob set. Protect the evaluator, correctness tests, fixtures, generated run state, and other off-limits paths.
5. Add fixed correctness commands, metric thresholds, and named worker probes. Probes must not emit the promotion metric.
6. Require an experiment, wall-time, or reported-cost limit. Use unlimited mode only when the user explicitly requests it.
7. Call `autoresearch_configure` with the complete `RunSpec` as JSON. Use schema version 1, frontier size 4, at least three baseline samples, and a finite command timeout.
8. Show the generated run spec and ask the user to review it. Do not call `/autoresearch start`; starting is a separate user action.

A valid setup has a Git root, non-overlapping editable and protected paths, successful fixed commands, finite required metrics, baseline samples, hard guards, and an explicit budget.
