---
name: autoresearch-worker
description: Make one assigned mutation or crossover change inside a confined frontier autoresearch worktree. Loaded only by the controller.
disable-model-invocation: true
---

# Complete one experiment

1. Read the assignment, editable paths, protected paths, and named probes.
2. Inspect the primary parent's files with `read`.
3. For crossover, inspect only the assigned donor with `inspect_donor`. Transplant one relevant idea; do not copy unrelated changes.
4. Make one coherent change with `write`, `edit`, `worker_delete`, or `worker_move`.
5. Use `worker_probe` only when a named probe can give useful feedback. Do not evaluate or promote the candidate.
6. Finish with one `candidate_submit` call. State the hypothesis, change, expected effect, and useful next step. For crossover, also state the donor idea.

Stay inside the editable scope. Git metadata, run state, protected files, the donor, and controller state are read-only. You have no shell tool. A missing submission or empty diff fails the experiment.
