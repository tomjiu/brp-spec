/**
 * Tests for v0.5.1 Status Indicator.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setStatus, updateBadge, onRequestStart, onRequestEnd,
  onBridgeConnect, onBridgeDisconnect, _resetForTest,
} from "../src/status-indicator";

// Mock browser.browserAction
const setIconMock = vi.fn(() => Promise.resolve());
const setBadgeTextMock = vi.fn(() => Promise.resolve());
const setBadgeBgMock = vi.fn(() => Promise.resolve());
vi.stubGlobal("browser", {
  browserAction: {
    setIcon: setIconMock,
    setBadgeText: setBadgeTextMock,
    setBadgeBackgroundColor: setBadgeBgMock,
  },
});

describe("status-indicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTest();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should set icon to gray on disconnected", () => {
    onBridgeConnect(); // idle first
    onBridgeDisconnect();
    const calls = setIconMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toEqual(
      expect.objectContaining({ path: expect.objectContaining({ 32: expect.stringContaining("gray") }) })
    );
  });

  it("should set icon to blue on bridge connect", () => {
    onBridgeConnect();
    expect(setIconMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.objectContaining({ 32: expect.stringContaining("blue") }) })
    );
  });

  it("should set icon to green on request start", () => {
    onRequestStart();
    expect(setIconMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.objectContaining({ 32: expect.stringContaining("green") }) })
    );
  });

  it("should set icon back to blue on successful request end", () => {
    onRequestStart();
    onRequestEnd(true);
    const calls = setIconMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toEqual(
      expect.objectContaining({ path: expect.objectContaining({ 32: expect.stringContaining("blue") }) })
    );
  });

  it("should set icon to red after 3 consecutive failures", () => {
    onBridgeConnect();
    onRequestStart(); onRequestEnd(false);
    onRequestStart(); onRequestEnd(false);
    onRequestStart(); onRequestEnd(false);
    const calls = setIconMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toEqual(
      expect.objectContaining({ path: expect.objectContaining({ 32: expect.stringContaining("red") }) })
    );
  });

  it("should reset failure count on success", () => {
    onBridgeConnect();
    onRequestStart(); onRequestEnd(false);
    onRequestStart(); onRequestEnd(false);
    onRequestStart(); onRequestEnd(true); // resets counter
    onRequestStart(); onRequestEnd(false); // only 1 failure after reset
    const calls = setIconMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toEqual(
      expect.objectContaining({ path: expect.objectContaining({ 32: expect.stringContaining("blue") }) })
    );
  });

  it("should auto-recover from error after 5s when connected", () => {
    onBridgeConnect();
    onRequestStart(); onRequestEnd(false);
    onRequestStart(); onRequestEnd(false);
    onRequestStart(); onRequestEnd(false); // error
    vi.advanceTimersByTime(5001);
    const calls = setIconMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toEqual(
      expect.objectContaining({ path: expect.objectContaining({ 32: expect.stringContaining("blue") }) })
    );
  });

  it("should update badge with tab count", () => {
    updateBadge(3);
    expect(setBadgeTextMock).toHaveBeenCalledWith({ text: "3" });
    updateBadge(0);
    expect(setBadgeTextMock).toHaveBeenLastCalledWith({ text: "" });
  });

  it("should not call setIcon when status unchanged", () => {
    onBridgeConnect(); // idle
    const callCount = setIconMock.mock.calls.length;
    setStatus("idle"); // same status
    expect(setIconMock.mock.calls.length).toBe(callCount);
  });
});
