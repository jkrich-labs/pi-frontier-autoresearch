# Domain glossary

- **Run** — one bounded autoresearch campaign against a single Git repository and evaluation contract.
- **Run spec** — the validated, generated instructions for a run: objective, metric, scope, constraints, evaluator, guards, and budget.
- **Controller** — trusted deterministic code that selects parents, schedules mutation or crossover, evaluates candidates, and updates the frontier.
- **Worker** — a fresh non-interactive Pi coding-agent process that makes one candidate change, then exits. A worker never decides promotion and cannot run the trusted evaluator.
- **Experiment** — one controller assignment, worker attempt, evaluation, and frontier decision.
- **Node** — an immutable git-backed candidate plus parentage, metrics, reflection, and productivity statistics. Discarded nodes remain searchable history.
- **Frontier** — the bounded population of four promoted nodes used as future parents.
- **BEST** — the frontier role for the strongest confirmed primary metric.
- **LEAN** — the frontier role for a candidate that preserves acceptable primary fitness while improving the configured cost metric. Changed lines are the fallback cost signal.
- **DIVERSE** — a frontier role that preserves a materially different, still-competitive search direction.
- **Mutation** — one coherent change made from one parent node.
- **Crossover** — one coherent idea transplanted from a complementary second parent into the primary parent's code.
- **Promotion** — the controller's deterministic decision to add or replace a frontier node after validation and noise-aware confirmation.
- **Evaluator** — the controller-owned command and parser that emit the primary metric and optional secondary metrics. Workers cannot edit or invoke it.
- **Guard** — a hard correctness, resource, path, or metric condition that every promoted candidate must satisfy.
- **Probe** — an optional allowlisted developer check a worker may invoke for feedback; probes cannot produce the promotion metric.
- **Protected path** — any path outside the editable scope, including the evaluator, tests or fixtures designated off limits, run state, and git metadata.
- **Policy tuning** — opt-in, schema-bounded adjustment of search weights and thresholds. It cannot change evaluators, guards, budgets, frontier size, or controller code.
