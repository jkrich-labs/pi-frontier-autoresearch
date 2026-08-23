import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "typebox";

import { WorkerConfinement } from "../../src/worker-confinement.ts";
import {
  CANDIDATE_SUBMISSION_PARAMETERS,
  WORKER_TOOL_ALLOWLIST,
  candidateSubmissionError,
  parseCandidateSubmission,
  parseWorkerGuardConfig,
  type WorkerGuardConfig,
} from "../../src/worker-contract.ts";

function text(content: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: content }], details };
}

function loadConfig(): WorkerGuardConfig {
  const path = process.env.PI_FRONTIER_WORKER_CONFIG;
  if (!path) throw new Error("PI_FRONTIER_WORKER_CONFIG is required");
  return parseWorkerGuardConfig(JSON.parse(requireRead(path)));
}

function requireRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read worker guard configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export default function workerGuard(pi: ExtensionAPI): void {
  const config = loadConfig();
  const confinement = new WorkerConfinement(config);
  let submitted = false;

  pi.registerTool({
    name: "read",
    label: "Read worktree file",
    description: "Read one file inside the candidate worktree. Output is limited to 50 KB.",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, params) {
      const path = await confinement.readablePath(params.path);
      const content = await readFile(path, "utf8");
      const lines = content.split("\n");
      const start = (params.offset ?? 1) - 1;
      let output = lines.slice(start, params.limit ? start + params.limit : undefined).join("\n");
      if (Buffer.byteLength(output) > 50 * 1024) output = `${output.slice(0, 50 * 1024)}\n[Output truncated at 50 KB]`;
      return text(output);
    },
  });

  pi.registerTool({
    name: "write",
    label: "Write editable file",
    description: "Create or replace one file in the configured editable scope.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute(_id, params) {
      const path = await confinement.mutablePath(params.path);
      return withFileMutationQueue(path, async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, params.content);
        return text(`Wrote ${params.path}`);
      });
    },
  });

  pi.registerTool({
    name: "edit",
    label: "Edit editable file",
    description: "Apply unique exact-text replacements to one file in the configured editable scope.",
    parameters: Type.Object({
      path: Type.String(),
      edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }),
    }),
    async execute(_id, params) {
      const path = await confinement.mutablePath(params.path);
      return withFileMutationQueue(path, async () => {
        let content = await readFile(path, "utf8");
        for (const edit of params.edits) {
          const first = content.indexOf(edit.oldText);
          if (first < 0) throw new Error(`Edit text was not found in ${params.path}`);
          if (content.indexOf(edit.oldText, first + edit.oldText.length) >= 0) {
            throw new Error(`Edit text is not unique in ${params.path}`);
          }
          content = `${content.slice(0, first)}${edit.newText}${content.slice(first + edit.oldText.length)}`;
        }
        await writeFile(path, content);
        return text(`Edited ${params.path}`);
      });
    },
  });

  pi.registerTool({
    name: "worker_delete",
    label: "Delete editable path",
    description: "Delete one file or directory wholly inside the configured editable scope.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params) {
      const path = await confinement.assertSafeTree(params.path);
      await rm(path, { recursive: true, force: true });
      return text(`Deleted ${params.path}`);
    },
  });

  pi.registerTool({
    name: "worker_move",
    label: "Move editable path",
    description: "Move one file or directory between paths wholly inside the configured editable scope.",
    parameters: Type.Object({ from: Type.String(), to: Type.String() }),
    async execute(_id, params) {
      const from = await confinement.assertSafeTree(params.from);
      const to = await confinement.mutablePath(params.to);
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      return text(`Moved ${params.from} to ${params.to}`);
    },
  });

  pi.registerTool({
    name: "worker_probe",
    label: "Run named probe",
    description: "Run one controller-configured probe by name. Arbitrary commands are not accepted.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params, signal) {
      const probe = confinement.probe(params.name);
      const environment = Object.entries(probe.env ?? {}).map(([name, value]) => `${name}=${value}`);
      const result = await pi.exec("env", [...environment, "/bin/sh", "-c", probe.command], {
        cwd: config.worktree,
        timeout: probe.timeoutMs,
        signal,
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return text(`${probe.name} exited ${result.code}\n${output}`.trim(), { exitCode: result.code });
    },
  });

  pi.registerTool({
    name: "inspect_donor",
    label: "Inspect assigned donor",
    description: "Read an editable file from the assigned immutable crossover donor.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params, signal) {
      if (config.operator !== "crossover" || !config.donorCommit) throw new Error("No crossover donor is assigned");
      const donorPath = await confinement.donorPath(params.path);
      const result = await pi.exec("git", ["show", `${config.donorCommit}:${donorPath}`], {
        cwd: config.worktree,
        timeout: 10_000,
        signal,
      });
      if (result.code !== 0) throw new Error(`Cannot inspect donor path ${params.path}: ${result.stderr.trim()}`);
      const output = Buffer.byteLength(result.stdout) > 50 * 1024
        ? `${result.stdout.slice(0, 50 * 1024)}\n[Output truncated at 50 KB]`
        : result.stdout;
      return text(output);
    },
  });

  pi.registerTool({
    name: "candidate_submit",
    label: "Submit candidate",
    description: "Submit the final structured candidate record exactly once, after completing the change.",
    parameters: CANDIDATE_SUBMISSION_PARAMETERS,
    async execute(_id, params) {
      if (submitted) throw new Error("A candidate submission has already been recorded");
      const issue = candidateSubmissionError(params, config.operator);
      if (issue) throw new Error(issue);
      submitted = true;
      const details = parseCandidateSubmission(params, config.operator)!;
      return { ...text("Candidate submission recorded", details as unknown as Record<string, unknown>), terminate: true };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.cwd !== config.worktree) throw new Error("Worker guard loaded outside its assigned worktree");
    pi.setActiveTools([...WORKER_TOOL_ALLOWLIST]);
  });

  pi.on("tool_call", (event) => {
    if (!(WORKER_TOOL_ALLOWLIST as readonly string[]).includes(event.toolName)) {
      return { block: true, reason: `Tool is not available to candidate workers: ${event.toolName}` };
    }
    return undefined;
  });
}
