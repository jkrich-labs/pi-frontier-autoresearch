import type { Clock } from "./adapters.ts";

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("Sleep cancelled"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

export class ManualClock implements Clock {
  #current: number;

  constructor(initialMilliseconds = 0) {
    this.#current = initialMilliseconds;
  }

  now(): number {
    return this.#current;
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error("Clock advance must be a non-negative finite number");
    }
    this.#current += milliseconds;
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error("Sleep cancelled");
    this.advance(milliseconds);
  }
}
