import { spawn } from "node:child_process";

import type { Clock, ProcessExecutor, ProcessRequest, ProcessResult } from "./adapters.ts";
import { SystemClock } from "./clock.ts";

export class NodeProcessExecutor implements ProcessExecutor {
  readonly #clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.#clock = clock;
  }

  async run(request: ProcessRequest, signal?: AbortSignal): Promise<ProcessResult> {
    const startedAt = this.#clock.now();
    return await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(request.command, [...(request.args ?? [])], {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let forceKill: NodeJS.Timeout | undefined;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));

      const terminate = (): void => {
        if (child.pid === undefined) return;
        try {
          if (process.platform === "win32") child.kill("SIGTERM");
          else process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        if (!forceKill) {
          forceKill = setTimeout(() => {
            if (child.pid === undefined || settled) return;
            try {
              if (process.platform === "win32") child.kill("SIGKILL");
              else process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }, 1_000);
        }
      };

      const timeout = request.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, request.timeoutMs)
        : undefined;
      const abort = () => {
        cancelled = true;
        terminate();
      };
      signal?.addEventListener("abort", abort, { once: true });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        signal?.removeEventListener("abort", abort);
        resolve({
          exitCode,
          stdout,
          stderr,
          durationMs: this.#clock.now() - startedAt,
          timedOut,
          cancelled,
        });
      });

      if (request.input !== undefined) child.stdin.end(request.input);
      else child.stdin.end();
      if (signal?.aborted) abort();
    });
  }

  async terminateProcessGroup(processGroupId: number): Promise<void> {
    if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
      throw new Error("Process group id must be a positive integer");
    }
    process.kill(-processGroupId, "SIGTERM");
  }
}
