/**
 * v0.6.0: Verify ts-rs generated types are importable and structurally compatible.
 */
import { describe, it, expect } from "vitest";
import type { GeneratedPrecondition, GeneratedInitializeResult, GeneratedCapabilities, GeneratedServerInfo, GeneratedSessionState, GeneratedClientInfo } from "../src/types";
import type { Precondition } from "../src/types.content";
import { handleInitialize } from "../src/handlers";

describe("ts-rs generated types", () => {
  it("GeneratedPrecondition should be importable", () => {
    const p: GeneratedPrecondition = { tagName: "button", textContains: null, attributes: null };
    expect(p.tagName).toBe("button");
  });

  it("hand-written Precondition should be compatible with generated Precondition", () => {
    const g: GeneratedPrecondition = { tagName: "button", textContains: null, attributes: null };
    // If generated type drifts (e.g. tagName removed), this tsc-compile-time assignment fails
    const adapted: Precondition = {
      tagName: g.tagName ?? undefined,
      textContains: g.textContains ?? undefined,
      attributes: g.attributes ?? undefined,
    };
    expect(adapted.tagName).toBe("button");
  });

  it("GeneratedInitializeResult should be importable and structurally sound", () => {
    const r: GeneratedInitializeResult = {
      sessionId: "s1",
      protocolVersion: "1.0",
      negotiatedVersion: "1.0",
      serverInfo: { name: "brp", version: "0.6.0" },
      capabilities: { features: [], actions: [], treeDeltaSupported: false, multiSession: false, maxRequestSize: null },
    };
    expect(r.sessionId).toBe("s1");
    expect(r.serverInfo.name).toBe("brp");
    expect(r.capabilities.actions).toEqual([]);
  });

  it("handleInitialize return should be assignable to GeneratedInitializeResult", () => {
    // This verifies that business code (handleInitialize) produces a value
    // compatible with ts-rs generated type. If generated type drifts,
    // tsc fails here at compile time.
    const result: GeneratedInitializeResult = handleInitialize({});
    expect(result.sessionId).toMatch(/^ext-/);
    expect(result.capabilities.treeDeltaSupported).toBe(false);
    expect(result.capabilities.actions).toContain("page.navigate");
  });
});
