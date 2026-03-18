import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createProviderRateLimiterInstance,
  resolveProviderRateLimiter,
  resetProviderRateLimiterForTest,
} from "./provider-rate-limit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNow(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// Flush all pending microtasks + any timer callbacks registered via setTimeout.
async function flushTimers() {
  vi.runAllTimers();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// createProviderRateLimiterInstance
// ---------------------------------------------------------------------------

describe("createProviderRateLimiterInstance", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe("RPM limits", () => {
    it("allows requests up to the limit immediately", async () => {
      const { now, advance: _ } = makeNow(1000);
      const limiter = createProviderRateLimiterInstance({ requestsPerMinute: 3 }, now);

      await expect(limiter.acquireSlot()).resolves.toBeUndefined();
      await expect(limiter.acquireSlot()).resolves.toBeUndefined();
      await expect(limiter.acquireSlot()).resolves.toBeUndefined();
    });

    it("queues the N+1 request when RPM is exhausted", async () => {
      const clock = makeNow(1000);
      const limiter = createProviderRateLimiterInstance({ requestsPerMinute: 2 }, clock.now);

      await limiter.acquireSlot();
      await limiter.acquireSlot();

      // Third request should queue.
      let thirdResolved = false;
      const third = limiter.acquireSlot().then(() => {
        thirdResolved = true;
      });

      await Promise.resolve(); // allow Promise.resolve() microtasks
      expect(thirdResolved).toBe(false);

      // Advance time past the window.
      clock.advance(60_001);
      await flushTimers();
      await third;
      expect(thirdResolved).toBe(true);
    });

    it("processes multiple queued requests after window rolls", async () => {
      const clock = makeNow(1000);
      const limiter = createProviderRateLimiterInstance({ requestsPerMinute: 1 }, clock.now);

      await limiter.acquireSlot();

      const results: number[] = [];
      const p1 = limiter.acquireSlot().then(() => results.push(1));
      const p2 = limiter.acquireSlot().then(() => results.push(2));
      const p3 = limiter.acquireSlot().then(() => results.push(3));

      await Promise.resolve();
      expect(results).toEqual([]);

      clock.advance(60_001);
      await flushTimers();
      await Promise.all([p1, p2, p3]);

      // All three resolved, FIFO order.
      expect(results).toEqual([1, 2, 3]);
    });

    it("resets window after 60 seconds and allows new requests", async () => {
      const clock = makeNow(1000);
      const limiter = createProviderRateLimiterInstance({ requestsPerMinute: 1 }, clock.now);

      await limiter.acquireSlot();

      clock.advance(60_000);
      // New window: should allow immediately.
      await expect(limiter.acquireSlot()).resolves.toBeUndefined();
    });
  });

  describe("TPM limits — output tokens", () => {
    it("queues next request when output TPM is exhausted", async () => {
      const clock = makeNow(1000);
      const limiter = createProviderRateLimiterInstance(
        { outputTokensPerMinute: 100 },
        clock.now,
      );

      await limiter.acquireSlot();
      limiter.recordUsage(0, 100); // exhaust output budget

      let queued = false;
      const p = limiter.acquireSlot().then(() => {
        queued = true;
      });

      await Promise.resolve();
      expect(queued).toBe(false);

      clock.advance(60_001);
      await flushTimers();
      await p;
      expect(queued).toBe(true);
    });

    it("allows requests when output tokens are below limit", async () => {
      const clock = makeNow(1000);
      const limiter = createProviderRateLimiterInstance(
        { outputTokensPerMinute: 1000 },
        clock.now,
      );

      await limiter.acquireSlot();
      limiter.recordUsage(0, 50);
      await expect(limiter.acquireSlot()).resolves.toBeUndefined();
    });
  });

  describe("TPM limits — input tokens", () => {
    it("queues next request when input TPM is exhausted", async () => {
      const clock = makeNow(1000);
      const limiter = createProviderRateLimiterInstance(
        { inputTokensPerMinute: 50 },
        clock.now,
      );

      await limiter.acquireSlot();
      limiter.recordUsage(50, 0); // exhaust input budget

      let queued = false;
      const p = limiter.acquireSlot().then(() => {
        queued = true;
      });

      await Promise.resolve();
      expect(queued).toBe(false);

      clock.advance(60_001);
      await flushTimers();
      await p;
      expect(queued).toBe(true);
    });
  });

  describe("AbortSignal", () => {
    it("rejects queued entry when signal is aborted", async () => {
      const clock = makeNow(1000);
      const limiter = createProviderRateLimiterInstance({ requestsPerMinute: 1 }, clock.now);

      await limiter.acquireSlot();

      const controller = new AbortController();
      const rejected = limiter.acquireSlot(controller.signal);

      await Promise.resolve();
      controller.abort();
      await expect(rejected).rejects.toMatchObject({ name: "AbortError" });
    });

    it("rejects immediately if signal is already aborted", async () => {
      const clock = makeNow(1000);
      const limiter = createProviderRateLimiterInstance({ requestsPerMinute: 1 }, clock.now);

      await limiter.acquireSlot();

      const controller = new AbortController();
      controller.abort();

      await expect(limiter.acquireSlot(controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
    });

    it("removes aborted entry from the queue so later entries can drain", async () => {
      const clock = makeNow(1000);
      const limiter = createProviderRateLimiterInstance({ requestsPerMinute: 1 }, clock.now);

      await limiter.acquireSlot();

      const controller = new AbortController();
      const abortedSlot = limiter.acquireSlot(controller.signal);
      const goodSlot = limiter.acquireSlot();

      await Promise.resolve();
      controller.abort();
      await expect(abortedSlot).rejects.toMatchObject({ name: "AbortError" });

      clock.advance(60_001);
      await flushTimers();
      await expect(goodSlot).resolves.toBeUndefined();
    });
  });

  describe("no limits configured", () => {
    it("allows all requests immediately when config is empty", async () => {
      const limiter = createProviderRateLimiterInstance({});

      for (let i = 0; i < 100; i++) {
        await expect(limiter.acquireSlot()).resolves.toBeUndefined();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// resolveProviderRateLimiter
// ---------------------------------------------------------------------------

describe("resolveProviderRateLimiter", () => {
  beforeEach(() => {
    resetProviderRateLimiterForTest("openai");
    resetProviderRateLimiterForTest("anthropic");
  });

  it("returns null when no rateLimits configured", () => {
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    } as unknown as Parameters<typeof resolveProviderRateLimiter>[1];

    expect(resolveProviderRateLimiter("openai", config)).toBeNull();
  });

  it("returns null when config is undefined", () => {
    expect(resolveProviderRateLimiter("openai", undefined)).toBeNull();
  });

  it("returns a limiter when rateLimits are configured", () => {
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
            rateLimits: { requestsPerMinute: 60 },
          },
        },
      },
    } as unknown as Parameters<typeof resolveProviderRateLimiter>[1];

    const limiter = resolveProviderRateLimiter("openai", config);
    expect(limiter).not.toBeNull();
    expect(typeof limiter?.acquireSlot).toBe("function");
    expect(typeof limiter?.recordUsage).toBe("function");
  });

  it("returns the same instance for identical config", () => {
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
            rateLimits: { requestsPerMinute: 60 },
          },
        },
      },
    } as unknown as Parameters<typeof resolveProviderRateLimiter>[1];

    const a = resolveProviderRateLimiter("openai", config);
    const b = resolveProviderRateLimiter("openai", config);
    expect(a).toBe(b);
  });

  it("creates a new instance when config changes", () => {
    const configA = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
            rateLimits: { requestsPerMinute: 60 },
          },
        },
      },
    } as unknown as Parameters<typeof resolveProviderRateLimiter>[1];

    const configB = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
            rateLimits: { requestsPerMinute: 30 },
          },
        },
      },
    } as unknown as Parameters<typeof resolveProviderRateLimiter>[1];

    const a = resolveProviderRateLimiter("openai", configA);
    const b = resolveProviderRateLimiter("openai", configB);
    expect(a).not.toBe(b);
  });

  it("resolves by normalized provider ID (case-insensitive)", () => {
    const config = {
      models: {
        providers: {
          OpenAI: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
            rateLimits: { requestsPerMinute: 10 },
          },
        },
      },
    } as unknown as Parameters<typeof resolveProviderRateLimiter>[1];

    const limiter = resolveProviderRateLimiter("openai", config);
    expect(limiter).not.toBeNull();
  });
});
