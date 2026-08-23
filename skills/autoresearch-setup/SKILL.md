---
name: autoresearch-setup
description: Turn a rough codebase optimisation goal into a validated frontier autoresearch run. Use only when the user invokes autoresearch setup.
disable-model-invocation: true
---

# Set up frontier autoresearch

Inspect the target Git repository and gather any decisions the controller cannot infer. Finish by calling `autoresearch_configure` with a mechanical metric, editable scope, protected paths, guards, and an explicit budget. Do not start experiments.
