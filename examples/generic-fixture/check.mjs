import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const artifact = await readFile(new URL("./src/artifact.txt", import.meta.url), "utf8");
assert.match(artifact, /PUBLIC_MARKER/);
console.log("correctness guard passed");
