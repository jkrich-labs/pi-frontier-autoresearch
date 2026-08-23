import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerFrontierAutoresearch } from "../extensions/pi-frontier-autoresearch/index.ts";
import {
  detectAutoresearchCommandConflict,
  type CommandProvenance,
} from "../src/command-conflict.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const packageName = "pi-frontier-autoresearch";
const fixtureArtifact = "examples/generic-fixture/src/artifact.txt";
const forbiddenGuidancePattern = "train\\.py|val_bpb|GPU|fine-tun(e|ing)";
const intentionalVerifyCommand = "npm run typecheck && npm test && npm pack --dry-run";

const packedManifest = [
  "ATTRIBUTIONS.md",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "examples/generic-fixture/README.md",
  "examples/generic-fixture/check.mjs",
  "examples/generic-fixture/measure.mjs",
  fixtureArtifact,
  "extensions/pi-frontier-autoresearch/index.ts",
  "extensions/pi-frontier-autoresearch/policy-review-guard.ts",
  "extensions/pi-frontier-autoresearch/worker-guard.ts",
  "package.json",
  "skills/autoresearch-setup/SKILL.md",
  "skills/autoresearch-worker/SKILL.md",
  "src/adapters.ts",
  "src/candidate.ts",
  "src/clock.ts",
  "src/command-conflict.ts",
  "src/command-router.ts",
  "src/configurator.ts",
  "src/contracts.ts",
  "src/coordinator.ts",
  "src/evaluator.ts",
  "src/frontier.ts",
  "src/git-workspace.ts",
  "src/index.ts",
  "src/metrics.ts",
  "src/paths.ts",
  "src/pi-worker.ts",
  "src/policy-reviewer.ts",
  "src/policy-tuning.ts",
  "src/process.ts",
  "src/run-spec.ts",
  "src/status-presentation.ts",
  "src/status-renderer.ts",
  "src/store.ts",
  "src/worker-confinement.ts",
  "src/worker-contract.ts",
] as const;

interface PackedFile {
  readonly path: string;
}

interface PackResult {
  readonly filename: string;
  readonly files: readonly PackedFile[];
}

interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface IsolatedPi {
  readonly temporary: string;
  readonly home: string;
  readonly agentDir: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

interface RpcCommand {
  readonly name?: string;
  readonly source?: string;
  readonly sourceInfo?: {
    readonly path?: string;
    readonly source?: string;
    readonly scope?: string;
    readonly origin?: string;
    readonly baseDir?: string;
  };
}

function run(command: string, args: readonly string[], options: RunOptions = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf8",
    env: options.env ?? { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function pack(args: readonly string[]): PackResult {
  const output = run("npm", ["pack", "--json", ...args]);
  const results = JSON.parse(output) as PackResult[];
  assert.equal(results.length, 1, output);
  return results[0]!;
}

async function createIsolatedPi(): Promise<IsolatedPi> {
  const temporary = await mkdtemp(join(tmpdir(), "pi-frontier-autoresearch-package-"));
  const home = join(temporary, "home");
  const agentDir = join(temporary, "pi");
  const cwd = join(temporary, "cwd");
  const npmCache = join(temporary, "npm-cache");
  const npmUserConfig = join(temporary, "npmrc");
  await Promise.all([mkdir(home), mkdir(agentDir), mkdir(cwd), mkdir(npmCache), writeFile(npmUserConfig, "")]);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    npm_config_offline: "true",
    npm_config_cache: npmCache,
    npm_config_userconfig: npmUserConfig,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  // PI_PACKAGE_DIR names Pi's own installed assets, not its managed package store.
  delete env.PI_PACKAGE_DIR;
  // `npm run` exports the caller's project-only allowScripts setting; it cannot
  // be forwarded to the isolated npm --prefix install.
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  return { temporary, home, agentDir, cwd, env };
}

function piBinary(): string {
  const binary = join(packageRoot, "node_modules", ".bin", "pi");
  assert.ok(existsSync(binary), "npm install must provide the Pi test executable");
  return binary;
}

async function enumerateCommands(piBinaryPath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<RpcCommand[]> {
  const child = spawn(piBinaryPath, ["--mode", "rpc", "--no-session", "--offline"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let response: ((commands: RpcCommand[]) => void) | undefined;
  let failure: ((error: Error) => void) | undefined;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline).replace(/\r$/, "");
      stdout = stdout.slice(newline + 1);
      newline = stdout.indexOf("\n");
      if (!line) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          command?: string;
          success?: boolean;
          data?: { commands?: RpcCommand[] };
        };
        if (event.type === "response" && event.command === "get_commands") {
          if (!event.success) {
            failure?.(new Error(`get_commands failed: ${line}`));
          } else {
            response?.(event.data?.commands ?? []);
          }
        }
      } catch (error) {
        failure?.(new Error(`Invalid Pi RPC output: ${line}\n${String(error)}`));
      }
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  try {
    return await new Promise<RpcCommand[]>((resolveCommands, rejectCommands) => {
      let settled = false;
      const onError = (error: Error) => finish(() => rejectCommands(error));
      const onExit = (code: number | null) => {
        if (code !== null) {
          finish(() => rejectCommands(new Error(`Pi exited before command enumeration (${code}). stderr: ${stderr}`)));
        }
      };
      const timeout = setTimeout(() => {
        finish(() => rejectCommands(new Error(`Timed out waiting for Pi to enumerate commands. stderr: ${stderr}`)));
      }, 15_000);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("error", onError);
        child.off("exit", onExit);
        callback();
      };
      response = (available) => finish(() => resolveCommands(available));
      failure = (error) => finish(() => rejectCommands(error));
      child.once("error", onError);
      child.once("exit", onExit);
      child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
    });
  } finally {
    child.kill("SIGTERM");
  }
}

function assertExtensionCommands(commands: readonly RpcCommand[], root: string, source?: string): void {
  for (const name of ["autoresearch", "autoresearch-prompt"]) {
    const command = commands.find((candidate) => candidate.name === name);
    assert.ok(command, `missing /${name}: ${JSON.stringify(commands)}`);
    assert.equal(command.source, "extension", JSON.stringify(command));
    assert.equal(command.sourceInfo?.origin, "package", JSON.stringify(command));
    assert.equal(command.sourceInfo?.scope, "user", JSON.stringify(command));
    assert.equal(command.sourceInfo?.baseDir, root, JSON.stringify(command));
    assert.equal(command.sourceInfo?.path, join(root, "extensions", "pi-frontier-autoresearch", "index.ts"), JSON.stringify(command));
    if (source !== undefined) assert.equal(command.sourceInfo?.source, source, JSON.stringify(command));
  }
}

async function assertActualProvenanceConflict(commands: readonly RpcCommand[]): Promise<void> {
  const actual = commands.find((command) => command.name === "autoresearch");
  assert.ok(actual?.source && actual.sourceInfo?.source && actual.sourceInfo.path, JSON.stringify(commands));
  const ours = actual as CommandProvenance;
  const legacy: CommandProvenance = {
    name: "autoresearch:1",
    source: "extension",
    sourceInfo: {
      source: "pi-autoresearch",
      path: "/actual/legacy/pi-autoresearch/index.ts",
    },
  };
  const conflict = detectAutoresearchCommandConflict([legacy, ours]);
  assert.deepEqual(conflict, {
    ours: `${ours.sourceInfo.source} (${ours.sourceInfo.path})`,
    other: `${legacy.sourceInfo.source} (${legacy.sourceInfo.path})`,
  });
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void> | void>();
  const warnings: string[] = [];
  const fakePi = {
    registerCommand() {},
    registerTool() {},
    getCommands: () => [legacy, ours],
    on(event: string, handler: (event: unknown, context: unknown) => Promise<void> | void) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  registerFrontierAutoresearch(fakePi, () => { throw new Error("conflict must return before runtime creation"); });
  await handlers.get("session_start")?.({}, {
    mode: "tui",
    ui: { notify(message: string, level: string) { if (level === "warning") warnings.push(message); } },
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes(ours.sourceInfo.source), warnings[0]);
  assert.ok(warnings[0]?.includes(legacy.sourceInfo.source), warnings[0]);
}

function scanForbiddenGuidance(root: string) {
  return spawnSync("grep", [
    "-RniE",
    "--",
    forbiddenGuidancePattern,
    join(root, "README.md"),
    join(root, "skills"),
    join(root, "extensions"),
    join(root, "examples"),
  ], { encoding: "utf8" });
}

function assertNoForbiddenGuidance(root: string): void {
  const result = scanForbiddenGuidance(root);
  assert.equal(result.status, 1, `forbidden guidance in ${root}:\n${result.stdout}${result.stderr}`);
}

function assertExactVerifyCommand(command: string): void {
  assert.equal(command, intentionalVerifyCommand, "verify must run its checks directly without invoking itself");
}

test("release manifest declares the Pi package and release verification", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    engines?: { node?: string };
    keywords?: string[];
    license?: string;
    scripts?: { verify?: string; "pack:check"?: string };
  };

  assert.equal(manifest.engines?.node, ">=22.19.0");
  assert.equal(manifest.license, "MIT");
  assert.ok(manifest.keywords?.includes("pi-package"));
  assertExactVerifyCommand(manifest.scripts?.verify ?? "");
  assert.equal(manifest.scripts?.["pack:check"], "npm pack --dry-run");
});

test("release verification rejects recursive command mutations", () => {
  for (const mutation of [
    "npm run verify",
    "npm run typecheck && npm run verify && npm pack --dry-run",
    "pnpm run verify",
    "yarn run verify",
  ]) {
    assert.throws(
      () => assertExactVerifyCommand(mutation),
      `verify guard accepted recursive mutation: ${mutation}`,
    );
  }
});

test("forbidden-guidance scan rejects lowercase and mixed-case fixtures in every guidance tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-frontier-autoresearch-guidance-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await Promise.all([
    mkdir(join(root, "skills")),
    mkdir(join(root, "extensions")),
    mkdir(join(root, "examples")),
  ]);
  await Promise.all([
    writeFile(join(root, "README.md"), "safe guidance\n"),
    writeFile(join(root, "skills", "uppercase.md"), "TRAIN.PY\n"),
    writeFile(join(root, "extensions", "mixed-case.md"), "fInE-TuNiNg\n"),
    writeFile(join(root, "examples", "lowercase.md"), "gPu and vAl_BpB\n"),
  ]);

  const result = scanForbiddenGuidance(root);
  assert.equal(result.status, 0, `case-insensitive fixture was not found:\n${result.stderr}`);
  for (const path of ["skills/uppercase.md", "extensions/mixed-case.md", "examples/lowercase.md"]) {
    assert.ok(result.stdout.includes(join(root, path)), `fixture was not scanned: ${path}`);
  }
});

test("README documents a generic workflow with an explicit finite or unlimited budget choice", async () => {
  const readme = await readFile(join(packageRoot, "README.md"), "utf8");
  for (const required of [
    "pi install ./path/to/pi-frontier-autoresearch",
    "pi install npm:pi-frontier-autoresearch@0.1.0",
    "/autoresearch-prompt Reduce build time",
    "METRIC name=value",
    "Every run requires an explicit budget choice",
    "An unlimited choice has no budget bound",
    "Workers receive no arbitrary shell tool",
    "trusted local commands, not a sandbox",
    "/autoresearch pause",
    "/autoresearch resume",
    "/autoresearch clear",
    "pi-autoresearch",
    "Node.js 22.19.0 or later",
    "Git with worktree support",
    "macOS or Linux",
    "no built-in ML behaviour, training",
    "npm run verify",
    "clean source checkout used to build the release artifact",
    "published tarball intentionally excludes tests and tsconfig",
    "Use `/autoresearch clear` before removing the package",
  ]) {
    assert.ok(readme.includes(required), `README is missing: ${required}`);
  }
  assert.match(readme, /or explicitly choose unlimited\s+execution/);
  for (const metric of [
    "METRIC build_ms=842",
    "METRIC test_ms=3180",
    "METRIC bundle_bytes=184320",
    "METRIC peak_rss_bytes=73400320",
    "METRIC p95_latency_ms=41.2",
  ]) {
    assert.ok(readme.includes(metric), `README is missing example: ${metric}`);
  }
});

test("package dry run has the exact sorted release manifest", () => {
  const result = pack(["--dry-run"]);
  const paths = result.files.map((file) => file.path).sort();
  assert.ok(paths.includes(fixtureArtifact), `missing packed fixture artifact: ${fixtureArtifact}`);
  assert.equal(paths.length, 38, "the release artifact file count is an explicit criterion");
  assert.ok(paths.every((path) => !path.startsWith("tests/") && path !== "tsconfig.json"));
  assert.deepEqual(paths, packedManifest, "packed files must exactly match the release manifest");
});

test("direct source package installation loads its commands", async (t) => {
  const isolated = await createIsolatedPi();
  t.after(async () => { await rm(isolated.temporary, { recursive: true, force: true }); });

  run(piBinary(), ["install", packageRoot], { cwd: isolated.cwd, env: isolated.env });
  const settings = JSON.parse(await readFile(join(isolated.agentDir, "settings.json"), "utf8")) as { packages?: unknown[] };
  const configuredSource = relative(isolated.agentDir, packageRoot) || ".";
  assert.deepEqual(settings.packages, [configuredSource]);

  const commands = await enumerateCommands(piBinary(), isolated.cwd, isolated.env);
  assertExtensionCommands(commands, packageRoot);
  await assertActualProvenanceConflict(commands);
});

test("generated archive installs as an isolated Pi package and loads commands and skills without a model call", async (t) => {
  const isolated = await createIsolatedPi();
  t.after(async () => { await rm(isolated.temporary, { recursive: true, force: true }); });

  const packed = pack(["--pack-destination", isolated.temporary]);
  const archive = resolve(isolated.temporary, packed.filename);
  const packageSpec = `npm:${packageName}@file:${archive}`;
  run(piBinary(), ["install", packageSpec], { cwd: isolated.cwd, env: isolated.env });

  const installedRoot = join(isolated.agentDir, "npm", "node_modules", packageName);
  assert.ok(existsSync(installedRoot), `Pi did not install ${packageName} from ${archive}`);
  const settings = JSON.parse(await readFile(join(isolated.agentDir, "settings.json"), "utf8")) as { packages?: unknown[] };
  assert.deepEqual(settings.packages, [packageSpec], "Pi must configure the installed archive package");
  const listed = run(piBinary(), ["list"], { cwd: isolated.cwd, env: isolated.env });
  assert.match(listed, new RegExp(packageSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(listed, new RegExp(installedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const commands = await enumerateCommands(piBinary(), isolated.cwd, isolated.env);
  assertExtensionCommands(commands, installedRoot, packageSpec);
  await assertActualProvenanceConflict(commands);
  for (const name of ["skill:autoresearch-setup", "skill:autoresearch-worker"]) {
    const command = commands.find((candidate) => candidate.name === name);
    assert.ok(command, `skills were suppressed or undiscovered: ${JSON.stringify(commands)}`);
    assert.equal(command.source, "skill", JSON.stringify(command));
    assert.equal(command.sourceInfo?.baseDir, installedRoot, JSON.stringify(command));
    assert.equal(command.sourceInfo?.source, packageSpec, JSON.stringify(command));
  }

  assert.match(
    run(process.execPath, ["examples/generic-fixture/measure.mjs"], { cwd: installedRoot, env: isolated.env }),
    /^METRIC bundle_bytes=\d+\n$/,
  );
  assert.match(
    run(process.execPath, ["examples/generic-fixture/check.mjs"], { cwd: installedRoot, env: isolated.env }),
    /^correctness guard passed\n$/,
  );

  assertNoForbiddenGuidance(packageRoot);
  assertNoForbiddenGuidance(installedRoot);
});
