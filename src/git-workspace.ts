import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  CandidateDiff,
  GitWorkspacePort,
  ProcessExecutor,
  WorktreeHandle,
} from "./adapters.ts";
import { isGitRefSafeSlug, type Assignment, type NodeRecord } from "./contracts.ts";
import { LOCAL_RUN_DIRECTORY } from "./paths.ts";
import { NodeProcessExecutor } from "./process.ts";

export interface GitWorkspaceOptions {
  repository: string;
  runId: string;
  runDirectory?: string;
  processExecutor?: ProcessExecutor;
}

function validateRefPart(value: string, label: string): string {
  if (!isGitRefSafeSlug(value)) throw new Error(`${label} is not safe for a Git ref: ${value}`);
  return value;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function metadataDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (path: string, name: string): Promise<void> => {
    const stat = await lstat(path);
    const kind = stat.isDirectory() ? "directory"
      : stat.isFile() ? "file"
      : stat.isSymbolicLink() ? "symlink"
      : "other";
    hash.update(`${JSON.stringify([name, kind, stat.mode & 0o7777])}\n`);
    if (stat.isDirectory()) {
      const entries = await readdir(path);
      entries.sort();
      for (const entry of entries) {
        await visit(resolve(path, entry), name === "" ? entry : `${name}/${entry}`);
      }
    } else if (stat.isFile()) {
      hash.update(await readFile(path));
      hash.update("\n");
    } else if (stat.isSymbolicLink()) {
      hash.update(await readlink(path));
      hash.update("\n");
    }
  };
  await visit(root, "");
  return hash.digest("hex");
}

function gitDirectoryFromMarker(worktreePath: string, marker: string): string {
  const match = /^gitdir: (.+)\r?\n?$/.exec(marker);
  if (!match?.[1]) throw new Error("Linked worktree has a malformed .git marker");
  return resolve(worktreePath, match[1]);
}

async function verifyAdministrativeCleanupPaths(worktree: WorktreeHandle): Promise<string> {
  const commonDirectory = worktree.gitCommonDirectory;
  const capturedCommonRealPath = worktree.gitCommonDirectoryRealPath;
  const gitDirectory = worktree.gitDirectory;
  const administrativeRoot = commonDirectory && resolve(commonDirectory, "worktrees");
  if (!commonDirectory || !capturedCommonRealPath || !gitDirectory || !administrativeRoot ||
    !isWithin(administrativeRoot, gitDirectory) || gitDirectory === administrativeRoot) {
    throw new Error("Refusing unsafe cleanup of compromised worktree metadata");
  }

  const relativeGitDirectory = relative(administrativeRoot, gitDirectory);
  const paths = [commonDirectory, administrativeRoot];
  let component = administrativeRoot;
  for (const part of relativeGitDirectory.split(sep)) {
    component = resolve(component, part);
    paths.push(component);
  }

  try {
    for (const [index, path] of paths.entries()) {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`${path} is not a real directory`);
      }
      const canonicalPath = await realpath(path);
      if ((index === 0 && canonicalPath !== capturedCommonRealPath) ||
        !isWithin(capturedCommonRealPath, canonicalPath)) {
        throw new Error(`${path} is outside the captured Git common directory`);
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing unsafe cleanup of compromised worktree metadata: ${detail}`);
  }
  return gitDirectory;
}

export class GitWorkspaceAdapter implements GitWorkspacePort {
  readonly repository: string;
  readonly runDirectory: string;
  readonly runId: string;
  readonly #process: ProcessExecutor;

  constructor(options: GitWorkspaceOptions) {
    this.repository = resolve(options.repository);
    const localRunDirectory = resolve(this.repository, LOCAL_RUN_DIRECTORY);
    this.runDirectory = resolve(options.runDirectory ?? localRunDirectory);
    if (this.runDirectory !== localRunDirectory) {
      throw new Error(`Worktrees must remain under ${LOCAL_RUN_DIRECTORY}`);
    }
    this.runId = validateRefPart(options.runId, "runId");
    this.#process = options.processExecutor ?? new NodeProcessExecutor();
  }

  nodeRef(nodeId: string): string {
    return `refs/pi-frontier-autoresearch/${this.runId}/nodes/${validateRefPart(nodeId, "nodeId")}`;
  }

  recordRef(nodeId: string): string {
    return `refs/pi-frontier-autoresearch/${this.runId}/records/${validateRefPart(nodeId, "nodeId")}`;
  }

  async #git(
    args: readonly string[],
    cwd = this.repository,
    options: { input?: string; trim?: boolean } = {},
  ): Promise<string> {
    const result = await this.#process.run({ command: "git", args, cwd, input: options.input });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`;
      throw new Error(`Git ${args[0] ?? "command"} failed: ${detail}`);
    }
    return options.trim === false ? result.stdout : result.stdout.trim();
  }

  async #prepareRunDirectory(): Promise<void> {
    const repository = await this.inspectRepository(this.repository);
    if (repository.root !== this.repository) {
      throw new Error(`Target repository root is ${repository.root}, not ${this.repository}`);
    }
    const gitPath = await this.#git(["rev-parse", "--git-path", "info/exclude"]);
    const excludePath = resolve(this.repository, gitPath);
    await mkdir(dirname(excludePath), { recursive: true });
    let exclude = "";
    try {
      exclude = await readFile(excludePath, "utf8");
    } catch {
      // Git creates this file lazily.
    }
    const runRelative = relative(this.repository, this.runDirectory).split(sep).join("/");
    const rule = `/${runRelative}/`;
    if (!exclude.split(/\r?\n/).includes(rule)) {
      await appendFile(excludePath, `${exclude.endsWith("\n") || exclude === "" ? "" : "\n"}${rule}\n`);
    }
    await mkdir(resolve(this.runDirectory, "worktrees"), { recursive: true });
  }

  async inspectRepository(path: string): Promise<{ root: string; head: string; clean: boolean }> {
    const cwd = resolve(path);
    const root = resolve(await this.#git(["rev-parse", "--show-toplevel"], cwd));
    const head = await this.#git(["rev-parse", "HEAD"], cwd);
    const status = await this.#git(["status", "--porcelain"], cwd);
    return { root, head, clean: status === "" };
  }

  async materialise(
    assignment: Assignment,
    parent: NodeRecord,
    donor?: NodeRecord,
  ): Promise<WorktreeHandle> {
    await this.#prepareRunDirectory();
    const experimentId = validateRefPart(assignment.experimentId, "experimentId");
    const worktreePath = resolve(this.runDirectory, "worktrees", experimentId);
    await rm(worktreePath, { recursive: true, force: true });
    await this.#git(["worktree", "add", "--detach", worktreePath, parent.commit]);
    const gitMetadata = await readFile(resolve(worktreePath, ".git"), "utf8");
    const gitDirectory = gitDirectoryFromMarker(worktreePath, gitMetadata);
    const commonPath = await this.#git(["rev-parse", "--git-common-dir"], worktreePath);
    const gitCommonDirectory = resolve(worktreePath, commonPath);
    if (!isWithin(resolve(gitCommonDirectory, "worktrees"), gitDirectory)) {
      throw new Error("Linked worktree Git directory is outside the common worktree metadata directory");
    }
    return {
      path: worktreePath,
      parentCommit: parent.commit,
      experimentId,
      donorCommit: donor?.commit,
      gitMetadata,
      gitDirectory,
      gitCommonDirectory,
      gitCommonDirectoryRealPath: await realpath(gitCommonDirectory),
      gitMetadataDigest: await metadataDigest(gitDirectory),
    };
  }

  async verifyGitMetadata(worktree: WorktreeHandle): Promise<{ intact: boolean; detail?: string }> {
    if (!worktree.gitDirectory || !worktree.gitMetadataDigest) {
      return { intact: false, detail: "integrity snapshot is missing" };
    }
    try {
      const current = await metadataDigest(worktree.gitDirectory);
      return current === worktree.gitMetadataDigest
        ? { intact: true }
        : { intact: false, detail: "linked worktree Git directory changed after materialisation" };
    } catch (error) {
      return {
        intact: false,
        detail: `linked worktree Git directory cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async rematerialiseAfterMetadataFailure(
    worktree: WorktreeHandle,
    assignment: Assignment,
    parent: NodeRecord,
    donor?: NodeRecord,
  ): Promise<WorktreeHandle> {
    const expectedWorktree = resolve(this.runDirectory, "worktrees", validateRefPart(worktree.experimentId, "experimentId"));
    if (worktree.path !== expectedWorktree) {
      throw new Error("Refusing unsafe cleanup of compromised worktree metadata");
    }
    const gitDirectory = await verifyAdministrativeCleanupPaths(worktree);

    // The worker is not OS-sandboxed. Once this contract check fails, delete only the
    // paths captured by the controller; never run Git in or commit from the compromised worktree.
    await rm(worktree.path, { recursive: true, force: true });
    await rm(gitDirectory, { recursive: true, force: true });
    await this.#git(["worktree", "prune"]);
    return this.materialise(assignment, parent, donor);
  }

  async inspectDiff(worktree: WorktreeHandle): Promise<CandidateDiff> {
    const files: string[] = [];
    if (worktree.gitMetadata !== undefined && await this.#restoreChangedGitMarker(worktree)) files.push(".git");
    const status = await this.#git(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
      worktree.path,
      { trim: false },
    );
    const fields = status === "" ? [] : status.split("\0");
    const untracked: string[] = [];
    for (let index = 0; index < fields.length; index += 1) {
      const entry = fields[index];
      if (!entry) continue;
      const statusCode = entry.slice(0, 2);
      const path = entry.slice(3);
      files.push(path);
      if (statusCode === "??" || statusCode === "!!") untracked.push(path);
      if (statusCode.includes("R") || statusCode.includes("C")) {
        const originalPath = fields[index + 1];
        if (!originalPath) throw new Error("Git returned an incomplete porcelain rename record");
        files.push(originalPath);
        index += 1;
      }
    }

    const numstat = await this.#git(["diff", "--numstat", "HEAD"], worktree.path);
    let changedLines = 0;
    for (const line of numstat.split("\n")) {
      if (!line) continue;
      const [added, deleted] = line.split("\t");
      changedLines += (Number.parseInt(added, 10) || 0) + (Number.parseInt(deleted, 10) || 0);
    }
    for (const path of untracked) {
      try {
        const bytes = await readFile(resolve(worktree.path, path));
        const content = bytes.toString("utf8");
        changedLines += content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      } catch {
        // A concurrently removed untracked file is still reported in the file list.
      }
    }
    const uniqueFiles = [...new Set(files)].sort();
    return { files: uniqueFiles, changedLines, empty: uniqueFiles.length === 0 };
  }

  async discardChanges(worktree: WorktreeHandle): Promise<void> {
    await this.#git(["reset", "--hard", "HEAD"], worktree.path);
    await this.#git(["clean", "-fdx"], worktree.path);
  }

  async commitCandidate(worktree: WorktreeHandle, message: string): Promise<{ commit: string; ref: string }> {
    await this.#git(["add", "--all", "--force"], worktree.path);
    await this.#git(["commit", "--allow-empty", "--no-gpg-sign", "-m", message], worktree.path);
    const commit = await this.#git(["rev-parse", "HEAD"], worktree.path);
    const ref = this.nodeRef(worktree.experimentId);
    await this.#git(["update-ref", ref, commit, "0000000000000000000000000000000000000000"]);
    return { commit, ref };
  }

  async persistNode(node: NodeRecord): Promise<string> {
    if (node.ref !== this.nodeRef(node.id)) {
      throw new Error(`Node ${node.id} has an unexpected Git ref`);
    }
    const existing = await this.#process.run({
      command: "git",
      args: ["rev-parse", "--verify", node.ref],
      cwd: this.repository,
    });
    if (existing.exitCode === 0 && existing.stdout.trim() !== node.commit) {
      throw new Error(`Node ref already points to a different commit: ${node.ref}`);
    }
    if (existing.exitCode !== 0) await this.#git(["update-ref", node.ref, node.commit]);

    const ref = this.recordRef(node.id);
    const object = await this.#git(
      ["hash-object", "-w", "--stdin"],
      this.repository,
      { input: `${JSON.stringify(node)}\n` },
    );
    await this.#git(["update-ref", ref, object]);
    return ref;
  }

  async readNodeRecord(nodeId: string): Promise<NodeRecord> {
    const serialized = await this.#git(["show", this.recordRef(nodeId)], this.repository, { trim: false });
    return JSON.parse(serialized) as NodeRecord;
  }

  async #restoreChangedGitMarker(worktree: WorktreeHandle): Promise<boolean> {
    const marker = resolve(worktree.path, ".git");
    let intact = false;
    try {
      const stat = await lstat(marker);
      intact = stat.isFile() && !stat.isSymbolicLink() && await readFile(marker, "utf8") === worktree.gitMetadata;
    } catch {
      // A missing or malformed linked-worktree marker is restored before invoking Git.
    }
    if (intact) return false;
    await rm(marker, { recursive: true, force: true });
    await writeFile(marker, worktree.gitMetadata!);
    return true;
  }

  async remove(worktree: WorktreeHandle): Promise<void> {
    try {
      await this.#git(["worktree", "remove", "--force", worktree.path]);
    } catch (error) {
      await rm(worktree.path, { recursive: true, force: true });
      await this.#git(["worktree", "prune"]);
      if ((await this.listWorktrees()).includes(worktree.path)) throw error;
    }
  }

  async listWorktrees(): Promise<string[]> {
    const output = await this.#git(["worktree", "list", "--porcelain"]);
    const prefix = `${resolve(this.runDirectory, "worktrees")}${sep}`;
    return output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice("worktree ".length)))
      .filter((path) => path.startsWith(prefix));
  }

  async recover(): Promise<void> {
    for (const path of await this.listWorktrees()) {
      const experimentId = path.slice(path.lastIndexOf(sep) + 1);
      await this.remove({ path, experimentId, parentCommit: "" });
    }
    await this.#git(["worktree", "prune"]);
  }

  /** Atomically delete only immutable refs owned by this configured run. */
  async clearRunRefs(): Promise<void> {
    const namespace = `refs/pi-frontier-autoresearch/${this.runId}/`;
    const output = await this.#git(["for-each-ref", "--format=%(refname)", namespace]);
    const refs = output.split("\n").filter(Boolean);
    if (refs.some((ref) => !ref.startsWith(namespace))) {
      throw new Error("Git returned a ref outside the run namespace; refusing clear");
    }
    if (refs.length === 0) return;
    const transaction = ["start", ...refs.map((ref) => `delete ${ref}`), "prepare", "commit", ""].join("\n");
    await this.#git(["update-ref", "--stdin"], this.repository, { input: transaction });
  }
}
