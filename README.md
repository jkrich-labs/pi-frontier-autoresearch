# Frontier autoresearch for Pi

`pi-frontier-autoresearch` runs bounded, controller-validated experiments in a
Git codebase. Give it a measurable optimisation goal; it creates isolated
candidate worktrees and retains a small frontier of checked results.

## Requirements

- Node.js 22.19.0 or later
- Git with worktree support
- macOS or Linux with a POSIX-compatible command environment
- Pi coding agent

Windows is not supported in this release. The target must be a Git repository.

## Install

Install a local checkout while developing:

```bash
pi install ./path/to/pi-frontier-autoresearch
```

Install a published release:

```bash
pi install npm:pi-frontier-autoresearch@0.1.0
```

Review a package before installing it. Pi extensions run with your user
permissions, and skills can instruct the agent to run commands.

## Set up a run

Start with a rough goal that names the outcome and its correctness condition:

```text
/autoresearch-prompt Reduce build time. The evaluator must emit METRIC build_ms=value and npm test must pass.
```

`/autoresearch <rough goal>` is an alias. The setup skill inspects the
repository, asks only for missing decisions, validates an authoritative run
configuration, and measures a baseline. It does not start experiments. Review
the generated configuration, then start explicitly:

```text
/autoresearch start
```

The controller owns the evaluator. Its metric command must emit one finite
numeric line in this form:

```text
METRIC name=value
```

Choose `lower` or `higher` for each metric in the configuration. Protect the
metric command, correctness checks, fixtures, run state, and every path outside
the editable scope. The controller rejects a candidate when a guard, protected
file check, diff scope check, or metric check fails.

Every run requires an explicit budget choice. Choose a finite maximum experiment
count, wall time, reported cost, or a combination, or explicitly choose unlimited
execution. An unlimited choice has no budget bound. Use a finite command timeout
and representative checks.

## Mechanical examples

Each example pairs a controller-owned metric with a correctness guard. These
values illustrate the required output; use commands that represent your project.

| Goal | Metric output | Correctness guard |
| --- | --- | --- |
| reduce build time | `METRIC build_ms=842` | `npm test` |
| reduce test runtime | `METRIC test_ms=3180` | `npm run lint` |
| reduce bundle size | `METRIC bundle_bytes=184320` | `node scripts/check-public-api.mjs` |
| reduce peak memory | `METRIC peak_rss_bytes=73400320` | `npm test` |
| reduce latency | `METRIC p95_latency_ms=41.2` | `node scripts/check-response.mjs` |

[`examples/generic-fixture`](examples/generic-fixture) contains a small,
deterministic metric command and guard. Copy its pattern, then replace it with
your real workload before starting a run.

## Commands

| Command | Action |
| --- | --- |
| `/autoresearch-prompt <goal>` | validate a run from a rough goal |
| `/autoresearch <goal>` | alias for setup |
| `/autoresearch start` | start a validated run |
| `/autoresearch pause` | stop after the current experiment boundary |
| `/autoresearch resume` | continue a paused or recovered run |
| `/autoresearch status` | show state, budget, frontier, and latest decision |
| `/autoresearch stop` | interrupt the current worker and stop the run |
| `/autoresearch clear` | remove local run history after confirmation |

## Safety and recovery

Workers receive no arbitrary shell tool. They can edit only the configured
scope and can run only named, allowlisted probes. The controller, not the
worker, runs the evaluator and decides promotion.

Your evaluator and probes are trusted local commands, not a sandbox. Review
them and the target repository before running a campaign, especially when they
build or execute untrusted code.

Run state is stored locally in `.frontier-autoresearch`; candidate worktrees are
separate from your main checkout. After a Pi restart, worker interruption, or
crash, use `/autoresearch resume`. The controller recovers at experiment
boundaries. Use `/autoresearch clear` only when you no longer need the local
history.

## Command conflict

The existing `pi-autoresearch` package also registers `/autoresearch`. If both
are installed, Pi may suffix one command and this package warns with both source
paths. Remove one package, restart Pi, and keep their state separate. This
package does not inspect or migrate legacy `.auto` state.

## Limitations and non-goals

This release runs one local candidate at a time. It does not support Windows,
non-Git targets, distributed workers, remote worktrees, browser dashboards, or
subjective goals without a mechanical metric and hard guards.

It has no built-in ML behaviour, training, dataset management, or specialised
hardware orchestration. It does not alter its controller, evaluator, guards,
or budget during a run.

## Remove

Remove the same source that you installed:

```bash
pi remove npm:pi-frontier-autoresearch
# or
pi remove ./path/to/pi-frontier-autoresearch
```

Removing the package does not delete run history. Delete
`.frontier-autoresearch` from a target repository only after you have finished
with its records.

## Licence and sources

The package is [MIT licensed](LICENSE). See [sources and attributions](ATTRIBUTIONS.md)
for explicit design and documentation credits.
