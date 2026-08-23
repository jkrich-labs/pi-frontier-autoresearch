import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { StoreAdapter, WorkerMarker } from "./adapters.ts";
import type { RunEvent, RunSpec, RunState } from "./contracts.ts";
import { LOCAL_RUN_DIRECTORY } from "./paths.ts";

const execFileAsync = promisify(execFile);

export class LocalRunStore implements StoreAdapter {
  readonly #repositoryRoot: string;
  readonly #directoryName: string;
  readonly #runDirectory: string;

  constructor(repositoryRoot: string, directoryName = LOCAL_RUN_DIRECTORY) {
    this.#repositoryRoot = repositoryRoot;
    this.#directoryName = directoryName;
    this.#runDirectory = join(repositoryRoot, directoryName);
  }

  async initialise(spec: RunSpec, state: RunState): Promise<void> {
    await this.#ensureExcluded();
    await mkdir(this.#runDirectory, { recursive: true });
    await this.#writeAtomic("config.json", spec);
    await this.snapshot(state);
  }

  async append(event: RunEvent): Promise<void> {
    await mkdir(this.#runDirectory, { recursive: true });
    await appendFile(join(this.#runDirectory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  }

  async snapshot(state: RunState): Promise<void> {
    await mkdir(this.#runDirectory, { recursive: true });
    await this.#writeAtomic("snapshot.json", state);
  }

  async load(): Promise<{ events: readonly RunEvent[]; snapshot?: RunState }> {
    const events = await readFile(join(this.#runDirectory, "events.jsonl"), "utf8")
      .then((content) => this.#parseEvents(content))
      .catch((error: unknown) => {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code === "ENOENT") return [] as RunEvent[];
        throw error;
      });
    const snapshot = await readFile(join(this.#runDirectory, "snapshot.json"), "utf8")
      .then((content) => JSON.parse(content) as RunState)
      .catch((error: unknown) => {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
        throw error;
      });
    return { events, snapshot };
  }

  async writeWorkerMarker(marker: WorkerMarker): Promise<void> {
    await this.#writeAtomic("worker.json", marker);
  }

  async readWorkerMarker(): Promise<WorkerMarker | undefined> {
    return await readFile(join(this.#runDirectory, "worker.json"), "utf8")
      .then((content) => JSON.parse(content) as WorkerMarker)
      .catch((error: unknown) => {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
        throw error;
      });
  }

  async clearWorkerMarker(): Promise<void> {
    await rm(join(this.#runDirectory, "worker.json"), { force: true });
  }

  async writeGeneratedSpec(content: string): Promise<void> {
    const target = join(this.#runDirectory, "run-spec.md");
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
  }

  async clear(): Promise<void> {
    await rm(this.#runDirectory, { recursive: true, force: true });
  }

  async #ensureExcluded(): Promise<void> {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: this.#repositoryRoot,
      encoding: "utf8",
    });
    const rawPath = stdout.trim();
    const excludePath = isAbsolute(rawPath) ? rawPath : resolve(this.#repositoryRoot, rawPath);
    await mkdir(dirname(excludePath), { recursive: true });
    const current = await readFile(excludePath, "utf8").catch(() => "");
    const entry = `/${this.#directoryName.replace(/^\/+/, "")}/`;
    if (!current.split(/\r?\n/).includes(entry)) {
      const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
      await appendFile(excludePath, `${separator}${entry}\n`, "utf8");
    }
  }

  #parseEvents(content: string): RunEvent[] {
    const lines = content.split("\n");
    const events: RunEvent[] = [];
    for (const [index, line] of lines.entries()) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as RunEvent);
      } catch (error) {
        const finalLine = index === lines.length - 1 || (index === lines.length - 2 && lines.at(-1) === "");
        if (finalLine) break;
        throw error;
      }
    }
    return events;
  }

  async #writeAtomic(name: string, value: unknown): Promise<void> {
    const target = join(this.#runDirectory, name);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }
}
