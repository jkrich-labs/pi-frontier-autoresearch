import { readFile } from "node:fs/promises";

const artifact = await readFile(new URL("./src/artifact.txt", import.meta.url));
console.log(`METRIC bundle_bytes=${artifact.byteLength}`);
