import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Clock, ProcessExecutor, ProcessGroupIdentity, ProcessRequest, ProcessResult } from "./adapters.ts";
import { SystemClock } from "./clock.ts";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

const DARWIN_PROCESS_TOKEN = "PI_FRONTIER_PROCESS_TOKEN";

/**
 * Identity is intentionally kernel-derived on Linux and launch-token-derived on
 * macOS. Darwin's `ps lstart` has only one-second precision, so it cannot safely
 * distinguish a rapidly reused PID. A fresh, inherited token remains inspectable
 * through Darwin `ps -E` and fails closed if the child clears it.
 */
interface LinuxLeaderDetails {
  startIdentity: string;
  processGroupId: number;
}

function linuxLeaderDetails(pid: number): LinuxLeaderDetails {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  // After /proc/<pid>/stat fields 1 (pid) and 2 (comm), pgrp is field 5 and
  // starttime is field 22.
  const processGroupId = Number(fields[2]);
  const startTicks = fields[19];
  if (!Number.isInteger(processGroupId) || processGroupId <= 0 || !startTicks) {
    throw new Error(`Could not read Linux process identity for process ${pid}`);
  }
  return { startIdentity: `linux:${startTicks}`, processGroupId };
}

function leaderStartIdentity(pid: number, darwinToken?: string): string {
  if (process.platform === "linux") return linuxLeaderDetails(pid).startIdentity;
  if (process.platform === "darwin" && darwinToken) return `darwin-token:${darwinToken}`;
  throw new Error("Durable POSIX process identities are supported only on macOS and Linux");
}

function leaderProcessGroupId(pid: number): number {
  if (process.platform === "linux") return linuxLeaderDetails(pid).processGroupId;
  if (process.platform === "darwin") {
    const output = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const processGroupId = Number(output);
    if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
      throw new Error(`Could not read Darwin process group for process ${pid}`);
    }
    return processGroupId;
  }
  throw new Error("Durable POSIX process identities are supported only on macOS and Linux");
}

function darwinIdentityCurrent(pid: number, identity: string): boolean {
  const token = identity.startsWith("darwin-token:") ? identity.slice("darwin-token:".length) : "";
  if (!token) return false;
  // `-ww` avoids output truncation; `-E` includes the inherited environment.
  const details = execFileSync("ps", ["-wwE", "-p", String(pid)], { encoding: "utf8" });
  return details.includes(`${DARWIN_PROCESS_TOKEN}=${token}`);
}

function assertIdentity(identity: ProcessGroupIdentity): void {
  if (!Number.isInteger(identity.processGroupId) || identity.processGroupId <= 0 ||
    !Number.isInteger(identity.leaderPid) || identity.leaderPid <= 0 || !identity.leaderStartIdentity) {
    throw new Error("Process group identity is invalid");
  }
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Process-group confirmation timeout must be a positive integer");
  }
}

function processGroupGone(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return true;
    // An uninspectable group might still exist. Do not turn an uncertain check into
    // a destructive action or a marker clear.
    if (code === "EPERM") return false;
    throw error;
  }
}

function killOwnedGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch {
    // This is only used by the process which just spawned the group. Falling back to
    // the leader prevents a callback/persistence failure from leaving it alive.
    process.kill(processGroupId, signal);
  }
}

export class NodeProcessExecutor implements ProcessExecutor {
  readonly #clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.#clock = clock;
  }

  async run(request: ProcessRequest, signal?: AbortSignal): Promise<ProcessResult> {
    const startedAt = this.#clock.now();
    return await new Promise<ProcessResult>((resolve, reject) => {
      const darwinToken = process.platform === "darwin" ? randomUUID() : undefined;
      const child = spawn(request.command, [...(request.args ?? [])], {
        cwd: request.cwd,
        env: {
          ...process.env,
          ...request.env,
          ...(darwinToken ? { [DARWIN_PROCESS_TOKEN]: darwinToken } : {}),
        },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let forceKill: NodeJS.Timeout | undefined;
      let groupNotification: Promise<void> = Promise.resolve();

      if (child.pid !== undefined && request.onProcessGroup) {
        let identity: ProcessGroupIdentity;
        try {
          const processGroupId = leaderProcessGroupId(child.pid);
          // A detached launch must make the child the leader of its own group. A
          // live POSIX group leader cannot subsequently move groups, which makes
          // this PID/start/PGID tuple a fail-closed ownership invariant.
          if (processGroupId !== child.pid) {
            throw new Error(`Spawned worker ${child.pid} is not its process-group leader`);
          }
          identity = {
            processGroupId,
            leaderPid: child.pid,
            leaderStartIdentity: leaderStartIdentity(child.pid, darwinToken),
          };
        } catch (error) {
          child.kill("SIGTERM");
          reject(error);
          return;
        }
        // Do not resolve the worker result before the controller has durably recorded
        // ownership. A stop that races spawn can then find the same identity.
        groupNotification = Promise.resolve(request.onProcessGroup(identity)).catch((error) => {
          killOwnedGroup(child.pid!, "SIGTERM");
          return Promise.reject(error);
        });
        // The close handler below returns this error to the caller. Attach a branch
        // now as well so a fast callback failure cannot become an unhandled rejection
        // while the terminating child drains its stdio.
        void groupNotification.catch(() => undefined);
      }

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));

      const terminate = (): void => {
        if (child.pid === undefined) return;
        try {
          if (process.platform === "win32") child.kill("SIGTERM");
          else killOwnedGroup(child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        if (!forceKill) {
          forceKill = setTimeout(() => {
            if (child.pid === undefined || settled) return;
            try {
              if (process.platform === "win32") child.kill("SIGKILL");
              else killOwnedGroup(child.pid, "SIGKILL");
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
        void groupNotification.then(
          () => resolve({
            exitCode,
            stdout,
            stderr,
            durationMs: this.#clock.now() - startedAt,
            timedOut,
            cancelled,
          }),
          (error) => reject(error),
        );
      });

      if (request.input !== undefined) child.stdin.end(request.input);
      else child.stdin.end();
      if (signal?.aborted) abort();
    });
  }

  async isProcessGroupIdentityCurrent(identity: ProcessGroupIdentity): Promise<boolean> {
    assertIdentity(identity);
    try {
      const startIdentityCurrent = process.platform === "darwin"
        ? darwinIdentityCurrent(identity.leaderPid, identity.leaderStartIdentity)
        : leaderStartIdentity(identity.leaderPid) === identity.leaderStartIdentity;
      // POSIX does not allow a live process-group leader (PID === PGID) to move to
      // another group. Require that immutable relationship too: a marker whose live
      // leader has another PGID is never safe to signal.
      return startIdentityCurrent && leaderProcessGroupId(identity.leaderPid) === identity.processGroupId;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      // `ps` returns non-zero when the PID has exited. Any uninspectable identity is
      // unsafe to signal, so callers fail closed.
      return false;
    }
  }

  async terminateOwnedProcessGroupAndWait(identity: ProcessGroupIdentity, timeoutMs: number): Promise<boolean> {
    assertIdentity(identity);
    assertTimeout(timeoutMs);
    // The in-process controller received this identity directly from spawn and has
    // not relinquished ownership. Check that the group still exists, then signal it
    // without requiring its leader to remain alive: while a POSIX group exists its
    // PGID cannot be reused, including when only descendants remain.
    if (processGroupGone(identity.processGroupId)) return true;
    try {
      process.kill(-identity.processGroupId, "SIGTERM");
    } catch (error) {
      if (errorCode(error) === "ESRCH") return true;
      throw error;
    }
    return await this.waitForProcessGroupExit(identity, timeoutMs);
  }

  async terminateRecoveredProcessGroupAndWait(identity: ProcessGroupIdentity, timeoutMs: number): Promise<boolean> {
    assertIdentity(identity);
    assertTimeout(timeoutMs);
    // Recovery has only durable state, never a live spawn ownership handle. This
    // immediately precedes process.kill and fails closed if the recorded leader is
    // gone or mismatched, so it cannot signal a reused group.
    if (!await this.isProcessGroupIdentityCurrent(identity)) return false;
    try {
      process.kill(-identity.processGroupId, "SIGTERM");
    } catch (error) {
      if (errorCode(error) === "ESRCH") return true;
      throw error;
    }
    return await this.waitForProcessGroupExit(identity, timeoutMs);
  }

  async waitForProcessGroupExit(identity: ProcessGroupIdentity, timeoutMs: number): Promise<boolean> {
    assertIdentity(identity);
    assertTimeout(timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (processGroupGone(identity.processGroupId)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise<void>((done) => setTimeout(done, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }
}
