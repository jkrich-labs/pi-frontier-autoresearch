import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, matchesGlob, relative, resolve, sep, win32 } from "node:path";

import type { ProbeSpec } from "./contracts.ts";
import { LOCAL_RUN_DIRECTORY } from "./paths.ts";

export interface WorkerConfinementOptions {
  worktree: string;
  editableGlobs: readonly string[];
  protectedPaths: readonly string[];
  runStatePaths?: readonly string[];
  probes?: readonly ProbeSpec[];
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function pathMatches(path: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return path === normalized || path.startsWith(`${normalized}/`) || matchesGlob(path, normalized);
}

export class WorkerConfinement {
  readonly worktree: string;
  readonly editableGlobs: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly runStatePaths: readonly string[];
  readonly probes: ReadonlyMap<string, ProbeSpec>;

  constructor(options: WorkerConfinementOptions) {
    this.worktree = resolve(options.worktree);
    this.editableGlobs = options.editableGlobs;
    this.protectedPaths = options.protectedPaths;
    this.runStatePaths = options.runStatePaths ?? [LOCAL_RUN_DIRECTORY, ".autoresearch", ".auto"];
    this.probes = new Map((options.probes ?? []).map((probe) => [probe.name, probe]));
  }

  relativePath(input: string): string {
    return this.#normalisePath(input, true);
  }

  async mutablePath(input: string): Promise<string> {
    const normalized = this.relativePath(input);
    if (!this.editableGlobs.some((pattern) => pathMatches(normalized, pattern))) {
      throw new Error(`Path is outside the editable scope: ${input}`);
    }
    await this.#rejectSymlinkPath(normalized);
    return resolve(this.worktree, normalized);
  }

  async readablePath(input: string): Promise<string> {
    const normalized = this.#normalisePath(input, false);
    const target = resolve(this.worktree, normalized);
    await this.#assertRealPathInside(target);
    return target;
  }

  async donorPath(input: string): Promise<string> {
    const normalized = this.relativePath(input);
    if (!this.editableGlobs.some((pattern) => pathMatches(normalized, pattern))) {
      throw new Error(`Donor path is outside the editable scope: ${input}`);
    }
    return normalized;
  }

  probe(name: string): ProbeSpec {
    const probe = this.probes.get(name);
    if (!probe) throw new Error(`Probe is not allowed: ${name}`);
    return probe;
  }

  async assertSafeTree(input: string): Promise<string> {
    const target = await this.mutablePath(input);
    let stat;
    try {
      stat = await lstat(target);
    } catch {
      return target;
    }
    if (!stat.isDirectory()) return target;
    const entries = await readdir(target, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      const child = relative(this.worktree, resolve(entry.parentPath, entry.name)).split(sep).join("/");
      await this.mutablePath(child);
    }
    return target;
  }

  #normalisePath(input: string, protectConfiguredPaths: boolean): string {
    if (typeof input !== "string" || input.trim() === "") throw new Error("Path must be a non-empty relative path");
    const value = input.startsWith("@") ? input.slice(1) : input;
    if (value.includes("\0")) throw new Error("Path must not contain a null byte");
    if (isAbsolute(value) || win32.isAbsolute(value)) throw new Error(`Absolute paths are not allowed: ${input}`);
    const slashPath = value.replaceAll("\\", "/");
    const segments = slashPath.split("/");
    if (segments.includes("..")) throw new Error(`Parent path escapes are not allowed: ${input}`);
    const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
    if (normalized === "") throw new Error("Path must name a file or directory");
    if (normalized.split("/").some((segment) => segment.toLowerCase() === ".git")) {
      throw new Error(`Git metadata is protected: ${input}`);
    }
    if (this.runStatePaths.some((pattern) => pathMatches(normalized, pattern))) {
      throw new Error(`Run state is protected: ${input}`);
    }
    if (protectConfiguredPaths && this.protectedPaths.some((pattern) => pathMatches(normalized, pattern))) {
      throw new Error(`Protected path cannot be changed: ${input}`);
    }
    const absolute = resolve(this.worktree, normalized);
    if (!isInside(this.worktree, absolute)) throw new Error(`Path escapes the worktree: ${input}`);
    return normalized;
  }

  async #rejectSymlinkPath(normalized: string): Promise<void> {
    let current = this.worktree;
    for (const segment of normalized.split("/")) {
      current = resolve(current, segment);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error(`Symlink paths cannot be changed: ${normalized}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    await this.#assertRealPathInside(current);
  }

  async #assertRealPathInside(target: string): Promise<void> {
    let existing = target;
    while (true) {
      try {
        const canonical = await realpath(existing);
        if (!isInside(await realpath(this.worktree), canonical)) {
          throw new Error(`Path follows a symlink outside the worktree: ${relative(this.worktree, target)}`);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = resolve(existing, "..");
        if (parent === existing) throw error;
        existing = parent;
      }
    }
  }
}
