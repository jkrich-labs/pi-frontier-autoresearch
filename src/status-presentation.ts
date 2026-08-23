import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { RunState } from "./contracts.ts";
import { renderFrontierFooter, renderFrontierStatus } from "./status-renderer.ts";

export const FRONTIER_STATUS_KEY = "frontier-autoresearch";
export const FRONTIER_WIDGET_KEY = "frontier-autoresearch-status";

export type StatusPresentationMode = "tui" | "rpc" | "json" | "print";

export interface StatusPresentationContext {
  mode: StatusPresentationMode;
  cwd: string;
  ui: ExtensionUIContext;
}

export interface IntervalScheduler {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemScheduler: IntervalScheduler = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

const STATUS_FAILURE_LIMIT = 120;

/**
 * Session-scoped widget lifecycle. It deliberately calls terminal UI APIs only
 * in real TUI mode; print, JSON, and RPC callers receive command messages
 * instead of terminal-specific component factories.
 */
export class FrontierStatusPresenter {
  readonly #load: (cwd: string) => Promise<RunState | undefined>;
  readonly #scheduler: IntervalScheduler;
  #state: RunState | undefined;
  #refreshFailure: string | undefined;
  #timer: unknown;
  #polling = false;
  #widgetInstalled = false;
  #requestRender: (() => void) | undefined;
  #active = false;
  #generation = 0;
  #requestGeneration = 0;
  #inFlight: Promise<void> | undefined;
  #failureNotified = false;

  constructor(
    load: (cwd: string) => Promise<RunState | undefined>,
    scheduler: IntervalScheduler = systemScheduler,
  ) {
    this.#load = load;
    this.#scheduler = scheduler;
  }

  async start(context: StatusPresentationContext): Promise<void> {
    const hadWidget = this.#widgetInstalled;
    this.#active = false;
    this.#generation++;
    this.#stopPolling();
    await this.#awaitInFlight();
    this.#state = undefined;
    this.#refreshFailure = undefined;
    this.#failureNotified = false;
    this.#requestRender = undefined;
    this.#widgetInstalled = false;

    if (context.mode !== "tui") return;
    if (hadWidget) {
      context.ui.setWidget(FRONTIER_WIDGET_KEY, undefined);
      context.ui.setStatus(FRONTIER_STATUS_KEY, undefined);
    }

    this.#active = true;
    const generation = this.#generation;
    await this.refresh(context);
    if (!this.#isLive(generation)) return;
    this.#timer = this.#scheduler.setInterval(() => this.#poll(context), 500);
    this.#polling = true;
  }

  /**
   * A refresh request is serialized behind its predecessor. A newer request
   * invalidates any older response before it can publish, so status never moves
   * backwards when disk recovery is slow.
   */
  async refresh(context: StatusPresentationContext): Promise<void> {
    if (context.mode !== "tui" || !this.#active) return;
    const generation = this.#generation;
    const request = ++this.#requestGeneration;
    const predecessor = this.#inFlight;
    const current = (async () => {
      if (predecessor) await predecessor;
      if (!this.#isLive(generation) || request !== this.#requestGeneration) return;
      try {
        const state = await this.#load(context.cwd);
        if (!this.#isLive(generation) || request !== this.#requestGeneration) return;
        this.#state = state;
        this.#refreshFailure = undefined;
        this.#failureNotified = false;
        this.#installWidget(context, generation);
        context.ui.setStatus(FRONTIER_STATUS_KEY, renderFrontierFooter(this.#state));
        this.#requestRender?.();
      } catch (error) {
        if (!this.#isLive(generation) || request !== this.#requestGeneration) return;
        try {
          this.#publishFailure(context, generation, error);
        } catch {
          // A UI adapter failure must not turn an interval callback into an
          // unhandled rejection. The next successful refresh repairs the view.
        }
      }
    })();
    this.#inFlight = current;
    void current.then(() => {
      if (this.#inFlight === current) this.#inFlight = undefined;
    });
    await current;
  }

  /** Invalidate first, drain all work, then clear the visible session resources. */
  async shutdown(context: StatusPresentationContext): Promise<void> {
    this.#active = false;
    this.#generation++;
    this.#stopPolling();
    try {
      await this.#awaitInFlight();
    } catch {
      // Shutdown still clears lifecycle state after an unexpected refresh failure.
    }

    this.#state = undefined;
    this.#refreshFailure = undefined;
    this.#failureNotified = false;
    this.#requestRender = undefined;
    this.#widgetInstalled = false;
    if (context.mode !== "tui") return;
    // The host may already have disposed its UI. Clear both resources
    // independently so one adapter failure cannot strand the other.
    try {
      context.ui.setWidget(FRONTIER_WIDGET_KEY, undefined);
    } catch {
      // Session cleanup is best-effort after terminal disposal.
    }
    try {
      context.ui.setStatus(FRONTIER_STATUS_KEY, undefined);
    } catch {
      // Session cleanup is best-effort after terminal disposal.
    }
  }

  #poll(context: StatusPresentationContext): void {
    if (!this.#active || this.#inFlight) return;
    // refresh contains all load/recovery failures; this defensive catch also
    // keeps future implementation mistakes out of the interval rejection path.
    void this.refresh(context).catch(() => undefined);
  }

  #publishFailure(context: StatusPresentationContext, generation: number, error: unknown): void {
    if (!this.#isLive(generation)) return;
    this.#state = undefined;
    this.#refreshFailure = boundedError(error);
    this.#installWidget(context, generation);
    context.ui.setStatus(FRONTIER_STATUS_KEY, renderFrontierFooter(undefined, this.#refreshFailure));
    this.#requestRender?.();
    if (this.#failureNotified) return;
    this.#failureNotified = true;
    context.ui.notify(`Autoresearch status refresh failed: ${this.#refreshFailure}`, "warning");
  }

  #installWidget(context: StatusPresentationContext, generation: number): void {
    if (this.#widgetInstalled) return;
    context.ui.setWidget(FRONTIER_WIDGET_KEY, (tui) => {
      if (this.#isLive(generation)) {
        this.#requestRender = () => {
          if (this.#isLive(generation)) tui.requestRender();
        };
      }
      return {
        render: (width: number) => renderFrontierStatus(this.#state, width, this.#refreshFailure),
        invalidate() {},
      };
    });
    this.#widgetInstalled = true;
  }

  async #awaitInFlight(): Promise<void> {
    const pending = this.#inFlight;
    if (pending) await pending;
  }

  #isLive(generation: number): boolean {
    return this.#active && this.#generation === generation;
  }

  #stopPolling(): void {
    if (!this.#polling) return;
    this.#scheduler.clearInterval(this.#timer);
    this.#timer = undefined;
    this.#polling = false;
  }
}

function boundedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/\s+/g, " ").trim() || "Unknown status refresh error.";
  return normalized.length <= STATUS_FAILURE_LIMIT
    ? normalized
    : `${normalized.slice(0, STATUS_FAILURE_LIMIT - 1)}…`;
}
