# Frontier autoresearch for Pi

`pi-frontier-autoresearch` runs measured code experiments in isolated Git worktrees. You give it an optimisation goal, a controller-owned metric, correctness checks, an editable scope, and a budget. It then tests candidate changes one at a time and keeps a four-node frontier of validated results.

The extension is for mechanical goals such as build time, test runtime, bundle size, memory use, or latency. It is not suitable for goals that depend only on subjective judgement.

## Requirements

- Node.js 22.19.0 or later
- Git with worktree support
- macOS or Linux with a POSIX-compatible command environment
- Pi coding agent
- a clean or intentionally prepared Git repository for the target project

Windows and non-Git targets are not supported in this release.

## Install

Review the source before installing it. Pi extensions run with your user permissions, and skills can instruct agents to run commands.

For a reproducible Git installation, pin the reviewed release tag:

```bash
pi install git:github.com/jkrich-labs/pi-frontier-autoresearch@v0.1.0
```

Install a local checkout while developing:

```bash
pi install ./path/to/pi-frontier-autoresearch
```

If an npm release is available, install that exact version:

```bash
pi install npm:pi-frontier-autoresearch@0.1.0
```

Restart Pi after installation.

## Quick start

### 1. Open Pi in the target repository

Run Pi from the Git repository you want to optimise. The extension stores local state in that repository and creates isolated worktrees from its commits.

### 2. Describe a measurable goal

Use `/autoresearch-prompt` with the outcome, metric command, correctness condition, and likely scope if you know them:

```text
/autoresearch-prompt Reduce build time. Run npm run measure-build for METRIC build_ms=value, require npm test to pass, allow edits under src/**, protect test fixtures, and stop after 20 experiments.
```

The shorter form `/autoresearch <rough goal>` starts the same setup flow when its first word is not a lifecycle command.

The setup agent inspects the repository and asks only for decisions it cannot infer safely. It then validates the complete run, executes repeated baseline measurements, and writes:

- `.frontier-autoresearch/config.json` — the authoritative configuration
- `.frontier-autoresearch/run-spec.md` — a readable summary for review
- `.frontier-autoresearch/events.jsonl` — the append-only run history

Setup does not start experiments.

### 3. Review the generated run

Before starting, check that:

- the primary metric measures the intended outcome
- `higher` or `lower` is correct for every metric
- correctness guards catch unacceptable changes
- editable globs contain only files the worker may change
- evaluator commands, guards, fixtures, and sensitive files are protected
- command timeouts and the run budget are appropriate

Every run requires an explicit budget choice. Choose a finite experiment count, wall time, reported cost, or combination, or explicitly choose unlimited execution. An unlimited choice has no budget bound.

Configuration is immutable. To change it, clear the current run and set up a new one.

### 4. Start the run

```text
/autoresearch start
```

Keep the Pi session open while a run is active. Pi runs one experiment at a time in the background and updates the frontier widget after persisted boundaries.

### 5. Monitor or control the run

```text
/autoresearch status
/autoresearch pause
/autoresearch resume
/autoresearch stop Optional reason
```

`pause` lets the current experiment finish, persists its boundary, and then pauses. `resume` continues a paused run in the same session. `stop` terminates an active worker or policy-review process group and then makes the run terminal. If a trusted evaluator command is already running, it may finish before the run reaches `stopped`.

A normal Pi session shutdown stops resources owned by that session. If Pi or the machine crashes before shutdown completes, run `/autoresearch status` after restarting Pi. Start, pause, resume, stop, and status recover durable state first; clear performs its own fail-closed ownership checks. Recovery verifies stale process ownership, cleans stale worktrees, and resumes only from a persisted boundary. A recovered run that is paused still needs `/autoresearch resume`.

### 6. Clear the run when finished

In the terminal UI, run:

```text
/autoresearch clear
```

Pi asks for confirmation. In print, JSON, RPC, or other non-interactive use, confirm explicitly:

```text
/autoresearch clear confirm
```

Clear first confirms that owned processes have exited. It then removes stale worktrees, local run state, logs, and only this run's namespaced Git refs. If process ownership is uncertain, clear fails without deleting evidence.

## What happens during an experiment

The controller follows the same persisted sequence for every experiment:

1. It checks the experiment, wall-time, and reported-cost budgets before assigning work.
2. It selects a parent and chooses mutation or crossover under the current frontier policy.
3. It creates an isolated worktree and launches a fresh Pi worker with only the worker skill and guard extension.
4. The worker makes one scoped change, may run named probes, and submits a structured explanation. Do not invoke the worker skill directly; the controller supplies its assignment and confinement data.
5. The controller verifies Git metadata and the diff, commits the candidate to an immutable namespaced ref, and removes the worktree.
6. The trusted evaluator runs fixed metric and correctness commands. Worker-reported scores never decide promotion.
7. A candidate that could enter the frontier receives adaptive parent-and-candidate confirmation measurements.
8. The controller records the evaluation, updates BEST, LEAN, and two DIVERSE slots when justified, persists the boundary, and checks the next budget.

Failed, rejected, and interrupted candidates remain in replayable lineage but cannot enter the frontier. The main checkout is not used as a candidate worktree.

## Guide for setup agents

When helping a user set up a run:

1. Start from the user's outcome, not a proposed code change.
2. Find a deterministic evaluator command that emits the declared metrics.
3. Find independent correctness commands that reject invalid output.
4. Propose the smallest useful editable scope and protect everything else.
5. Ask the user to choose a finite budget unless they explicitly request unlimited execution.
6. Use `/autoresearch-prompt <goal>` and answer the setup skill's questions with repository evidence.
7. Show the generated run summary. Do not start the run unless the user separately asks to start it.

Do not write directly to `.frontier-autoresearch`, construct worker assignments, invoke the worker skill, or trust candidate-supplied metrics. Use `/autoresearch status` to read controller state.

## Metric and guard contract

The evaluator command must emit one unique finite line for each declared metric:

```text
METRIC name=value
```

Metric names start with a letter and may contain letters, numbers, dots, underscores, and hyphens. Values must parse as finite numbers. Extra undeclared metrics, duplicate metrics, missing metrics, malformed lines, non-zero exits, and timeouts fail evaluation.

Guards may be fixed correctness commands, metric thresholds, or changed-lines limits. A candidate must pass every guard and remain within protected-path and editable-scope rules before its metrics can affect the frontier.

## Mechanical examples

Each example pairs a controller-owned metric with a correctness guard. Replace the example values and commands with representative project commands.

| Goal | Metric output | Direction | Correctness guard |
| --- | --- | --- | --- |
| reduce build time | `METRIC build_ms=842` | lower | `npm test` |
| reduce test runtime | `METRIC test_ms=3180` | lower | `npm run lint` |
| reduce bundle size | `METRIC bundle_bytes=184320` | lower | `node scripts/check-public-api.mjs` |
| reduce peak memory | `METRIC peak_rss_bytes=73400320` | lower | `npm test` |
| reduce latency | `METRIC p95_latency_ms=41.2` | lower | `node scripts/check-response.mjs` |

[`examples/generic-fixture`](examples/generic-fixture) contains a small deterministic metric command and guard. Copy its pattern, then replace both commands with your real workload before starting a run.

## Commands

| Command | Action |
| --- | --- |
| `/autoresearch-prompt <goal>` | inspect the repository and configure a run from a rough goal |
| `/autoresearch <goal>` | start setup when the first word is not `start`, `pause`, `resume`, `status`, `stop`, or `clear` |
| `/autoresearch start` | start a validated, configured run |
| `/autoresearch pause` | finish the current experiment boundary, then pause |
| `/autoresearch resume` | continue a paused run |
| `/autoresearch status` | recover if needed, then show state, budget, frontier, policy, and latest decision |
| `/autoresearch stop [reason]` | terminate an active worker or reviewer, wait for any active evaluator, and stop permanently |
| `/autoresearch clear` | confirm and remove this run's local artifacts and refs |
| `/autoresearch clear confirm` | clear without an interactive confirmation prompt |

In the terminal UI, the widget shows run state, remaining budget, active assignment, baseline and best metric, frontier roles, latest decision, and policy version. Print mode writes command results as text. JSON and RPC modes emit structured `frontier-autoresearch-command` messages and make no terminal-only calls.

## Frontier and policy modes

The frontier has up to four unique nodes:

- `BEST` — strongest confirmed primary fitness
- `LEAN` — competitive primary fitness with a smaller changed-line count
- `DIVERSE 1` and `DIVERSE 2` — useful, sufficiently fit alternatives with novel coverage

Fixed policy mode is the default. If setup explicitly enables experimental policy tuning, a stalled or degenerating run may ask a fresh constrained reviewer for bounded frontier-parameter changes. Reviews are rate-limited and versioned. They cannot change the evaluator, guards, budget, frontier size, controller code, or allowed parameter ranges.

## Safety model

Workers receive no arbitrary shell tool. They can edit only configured paths, inspect only an assigned crossover donor, and run only named probes. The controller verifies the resulting Git diff before retaining a candidate.

The evaluator, correctness guards, and probes are trusted local commands, not a sandbox. They run with your user permissions and may execute code from the target repository. Review them before starting, especially when the repository or its dependencies are untrusted.

All generated state, candidate worktrees, and raw logs stay under `.frontier-autoresearch`. Git excludes and worker guards protect this directory. Candidate commits also use refs under this run's `refs/pi-frontier-autoresearch/<runId>/` namespace.

## Recovery states

Use `/autoresearch status` first after an unexpected interruption.

- `running` — recovery continues from the last persisted boundary when ownership is absent or safely confirmed; otherwise it fails closed
- `paused` — inspect status, then use `/autoresearch resume`
- `stopped` — terminal; clear and configure a new run to continue experimenting
- `completed` or `budget exhausted` — terminal; inspect results, then clear when no longer needed
- `failed` — read the latest decision and event history; uncertain process ownership must be resolved before clear can succeed

Do not delete `.frontier-autoresearch` by hand while a worker may still be alive. Doing so removes the ownership evidence used for safe recovery.

## Command conflict

The existing `pi-autoresearch` package also registers `/autoresearch`. If both packages are installed, Pi may suffix one command. This package emits one warning naming both sources and does not start its runtime while the conflict exists.

Remove one package and restart Pi. This package does not inspect, mutate, or migrate legacy `.auto` state.

## Limitations and non-goals

This release runs one local candidate at a time. It does not support Windows, non-Git targets, distributed workers, remote worktrees, browser dashboards, or subjective goals without a mechanical metric and hard guards.

It has no built-in ML behaviour, training, dataset management, or specialised hardware orchestration. It does not alter its controller, evaluator, guards, or budget during a run. Optional policy tuning changes only validated frontier parameters within fixed bounds.

## Update or remove

A tagged Git installation is pinned. To upgrade, review the new tag, then install that source explicitly:

```bash
pi install git:github.com/jkrich-labs/pi-frontier-autoresearch@v0.2.0
```

Use `/autoresearch clear` before removing the package if you also want to remove the current run's local history, worktrees, logs, and namespaced Git refs. Then remove the same source you installed:

```bash
pi remove git:github.com/jkrich-labs/pi-frontier-autoresearch
# or
pi remove npm:pi-frontier-autoresearch
# or
pi remove ./path/to/pi-frontier-autoresearch
```

Removing the package alone does not delete run history or Git refs. If you keep the history, reinstall the same package source before using `/autoresearch clear`.

## Developer verification

Run `npm run verify` in a clean source checkout used to build the release artifact (the packed-source checkout for that artifact). It typechecks, runs the test suite, checks local and packed installation, and checks the exact 38-file package contents.

The published tarball intentionally excludes tests and tsconfig under that explicit package-content criterion. Verification happens in release source, not inside the runtime tarball.

## Licence and sources

The package is [MIT licensed](LICENSE). See [sources and attributions](ATTRIBUTIONS.md) for explicit design and documentation credits.
