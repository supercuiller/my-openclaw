/**
 * Per-provider FIFO rate limiter for LLM API requests.
 *
 * Enforces configurable per-minute limits on:
 *   - requests per minute (RPM)
 *   - input tokens per minute (input TPM)
 *   - output tokens per minute (output TPM)
 *
 * Excess requests are queued in FIFO order and executed once the current
 * 1-minute window rolls over. Queued slots respect AbortSignals so they are
 * cleaned up when sessions abort or yield.
 *
 * Token counts are recorded after each LLM response completes (post-hoc).
 * This means TPM limits operate on completed request totals for the window,
 * not on in-flight estimates.
 */

import type { ModelRateLimitConfig } from "../config/types.models.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../agents/provider-id.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawConfig } from "../config/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderRateLimiter = {
  /**
   * Acquire a slot before sending an LLM request.
   *
   * Resolves immediately if the current window is under all configured limits.
   * Otherwise suspends the caller in a FIFO queue until the next window opens.
   *
   * @param signal - Optional AbortSignal. When aborted, the queued entry is
   *   removed and the returned promise rejects with an AbortError.
   */
  acquireSlot: (signal?: AbortSignal) => Promise<void>;
  /**
   * Record token usage for a completed LLM response.
   * Must be called once per successful response to keep TPM tracking accurate.
   */
  recordUsage: (inputTokens: number, outputTokens: number) => void;
};

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000;

type WindowState = {
  windowStartMs: number;
  requestCount: number;
  inputTokenCount: number;
  outputTokenCount: number;
};

type QueueEntry = {
  resolve: () => void;
  reject: (err: Error) => void;
};

function createWindowState(): WindowState {
  return {
    windowStartMs: 0,
    requestCount: 0,
    inputTokenCount: 0,
    outputTokenCount: 0,
  };
}

function rollWindowIfNeeded(state: WindowState, nowMs: number): void {
  if (nowMs - state.windowStartMs >= WINDOW_MS) {
    state.windowStartMs = nowMs;
    state.requestCount = 0;
    state.inputTokenCount = 0;
    state.outputTokenCount = 0;
  }
}

function isUnderLimits(state: WindowState, config: ModelRateLimitConfig): boolean {
  if (config.requestsPerMinute !== undefined && state.requestCount >= config.requestsPerMinute) {
    return false;
  }
  if (
    config.inputTokensPerMinute !== undefined &&
    state.inputTokenCount >= config.inputTokensPerMinute
  ) {
    return false;
  }
  if (
    config.outputTokensPerMinute !== undefined &&
    state.outputTokenCount >= config.outputTokensPerMinute
  ) {
    return false;
  }
  return true;
}

function createProviderRateLimiterInstance(
  config: ModelRateLimitConfig,
  now: () => number = Date.now,
): ProviderRateLimiter {
  const state = createWindowState();
  const queue: QueueEntry[] = [];
  let drainTimerId: ReturnType<typeof setTimeout> | undefined;

  function timeUntilNextWindowMs(): number {
    const nowMs = now();
    return Math.max(1, WINDOW_MS - (nowMs - state.windowStartMs));
  }

  function scheduleDrain(): void {
    if (drainTimerId !== undefined) {
      return;
    }
    drainTimerId = setTimeout(() => {
      drainTimerId = undefined;
      drainQueue();
    }, timeUntilNextWindowMs());
  }

  function drainQueue(): void {
    const nowMs = now();
    rollWindowIfNeeded(state, nowMs);

    while (queue.length > 0) {
      if (!isUnderLimits(state, config)) {
        // Still over limit in the new window (e.g. TPM from previous window's
        // tokens carried context; in practice requestCount resets).
        scheduleDrain();
        return;
      }
      const entry = queue.shift();
      if (!entry) {
        break;
      }
      state.requestCount += 1;
      entry.resolve();
    }
  }

  function acquireSlot(signal?: AbortSignal): Promise<void> {
    const nowMs = now();
    rollWindowIfNeeded(state, nowMs);

    if (isUnderLimits(state, config)) {
      state.requestCount += 1;
      return Promise.resolve();
    }

    // Queue the caller and wait for the next window.
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { resolve, reject };
      queue.push(entry);

      if (signal) {
        const onAbort = () => {
          const index = queue.indexOf(entry);
          if (index !== -1) {
            queue.splice(index, 1);
          }
          const abortError = new Error("Rate limit queue aborted");
          abortError.name = "AbortError";
          reject(abortError);
        };

        if (signal.aborted) {
          // Already aborted — remove immediately and reject.
          const index = queue.indexOf(entry);
          if (index !== -1) {
            queue.splice(index, 1);
          }
          const abortError = new Error("Rate limit queue aborted");
          abortError.name = "AbortError";
          reject(abortError);
          return;
        }

        signal.addEventListener("abort", onAbort, { once: true });
        // Clean up the abort listener once the slot is granted.
        const originalResolve = entry.resolve;
        entry.resolve = () => {
          signal.removeEventListener("abort", onAbort);
          originalResolve();
        };
      }

      scheduleDrain();
    });
  }

  function recordUsage(inputTokens: number, outputTokens: number): void {
    state.inputTokenCount += Math.max(0, inputTokens);
    state.outputTokenCount += Math.max(0, outputTokens);
  }

  return { acquireSlot, recordUsage };
}

// ---------------------------------------------------------------------------
// Global singleton registry
// ---------------------------------------------------------------------------

type LimiterEntry = {
  limiter: ProviderRateLimiter;
  configKey: string;
};

const REGISTRY_KEY = Symbol.for("openclaw.providerRateLimiters");

function getRegistry(): Map<string, LimiterEntry> {
  return resolveGlobalSingleton(REGISTRY_KEY, () => new Map<string, LimiterEntry>());
}

/**
 * Resolve or create a `ProviderRateLimiter` for the given provider from the
 * current config.
 *
 * Returns `null` when no `rateLimits` are configured for this provider.
 *
 * The limiter instance is cached globally by normalized provider ID. If the
 * config changes (detected by `JSON.stringify` comparison), a new limiter is
 * created (discarding the previous window state and queue).
 */
export function resolveProviderRateLimiter(
  provider: string,
  config?: OpenClawConfig,
): ProviderRateLimiter | null {
  const providers = config?.models?.providers;
  const rateLimits =
    providers?.[provider]?.rateLimits ??
    findNormalizedProviderValue(providers, provider)?.rateLimits;

  if (!rateLimits) {
    return null;
  }

  const normalizedId = normalizeProviderId(provider);
  const configKey = JSON.stringify(rateLimits);
  const registry = getRegistry();
  const existing = registry.get(normalizedId);

  if (existing && existing.configKey === configKey) {
    return existing.limiter;
  }

  const limiter = createProviderRateLimiterInstance(rateLimits);
  registry.set(normalizedId, { limiter, configKey });
  return limiter;
}

/**
 * Remove the cached limiter for a provider.
 * Primarily used in tests to reset state between runs.
 */
export function resetProviderRateLimiterForTest(provider: string): void {
  const normalizedId = normalizeProviderId(provider);
  const registry = getRegistry();
  registry.delete(normalizedId);
}

// Export for testing.
export { createProviderRateLimiterInstance };
