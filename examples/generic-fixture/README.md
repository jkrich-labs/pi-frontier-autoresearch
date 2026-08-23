# Generic metric fixture

Copy this directory into a small Git repository to practise a mechanical
contract. Keep `measure.mjs` and `check.mjs` protected, and make only
`src/artifact.txt` editable.

```bash
node measure.mjs  # METRIC bundle_bytes=...
node check.mjs    # correctness guard
```

The metric is the byte length of the editable artifact. The guard requires its
public marker to remain. It is deliberately small and deterministic; replace
both commands with representative commands before a real run.
