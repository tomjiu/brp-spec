/**
 * Tests for extension/src/native.ts — B1 Native Messaging Auto-Link.
 *
 * Uses jest-like Vitest mocks for `browser.runtime.connectNative`.
 * These are unit tests — they mock the browser API without real Firefox.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBridge } from "../src/native";

// ─── Mock browser API ───

const mockPort = () => {
  const listeners: Array<(msg: unknown) => void> = [];
  return {
    onMessage: {
      addListener: vi.fn((cb: (msg: unknown) => void) => listeners.push(cb)),
      removeListener: vi.fn(),
    },
    disconnect: vi.fn(),
    postMessage: vi.fn(),
    // Helper for tests
    _deliver(msg: unknown) {
      listeners.forEach((cb) => cb(msg));
    },
  };
};

let portMock: ReturnType<typeof mockPort>;

// Mock global browser object
(globalThis as Record<string, unknown>).browser = {
  runtime: {
    connectNative: vi.fn(() => portMock),
  },
};

// Mock WebSocket
class MockWebSocket {
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  close = vi.fn();
  private listeners: Record<string, Array<() => void>> = {};

  constructor(url: string) {
    this.url = url;
    // Auto-open on next tick to simulate connection
    setTimeout(() => this.onopen?.(), 0);
  }

  addEventListener(event: string, handler: () => void): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }
}

(globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown as typeof WebSocket;

// ─── Tests ───

describe("startBridge", () => {
  beforeEach(() => {
    portMock = mockPort();
    (browser.runtime.connectNative as ReturnType<typeof vi.fn>).mockReturnValue(portMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("should receive token and connect WebSocket", async () => {
    const wsPromise = startBridge();

    // Simulate bridge delivering token
    portMock._deliver({ port: 19817, token: "test-uuid" });

    // Advance timers to trigger mock WebSocket onopen (0ms setTimeout)
    await vi.advanceTimersByTimeAsync(10);

    const ws = await wsPromise;
    expect(ws).toBeInstanceOf(MockWebSocket);
    expect((ws as MockWebSocket).url).toBe("ws://127.0.0.1:19817");
    // Port stays open — bridge must remain alive for WS session
    expect(portMock.disconnect).not.toHaveBeenCalled();
    expect(browser.runtime.connectNative).toHaveBeenCalledWith("org.brp.bridge");
  });

  it("should timeout after 3 seconds with no token", async () => {
    const wsPromise = startBridge();

    // No token delivered → advance 3 seconds
    vi.advanceTimersByTime(3100);

    await expect(wsPromise).rejects.toThrow(/Bridge not installed/);
    // Timeout path disconnects port to clean up
    expect(portMock.disconnect).toHaveBeenCalled();
  });

  it("should throw when connectNative is unavailable", async () => {
    (browser.runtime.connectNative as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("connectNative not available");
    });

    await expect(startBridge()).rejects.toThrow(/Bridge not installed/);
  });

  it("should reject malformed token messages", async () => {
    const wsPromise = startBridge();

    // Send non-object message
    portMock._deliver("not an object");

    await expect(wsPromise).rejects.toThrow(/Unexpected bridge message/);
  });
});
