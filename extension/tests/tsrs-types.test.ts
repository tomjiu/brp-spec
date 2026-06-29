/**
 * v0.6.0: Verify ts-rs generated types are importable and structurally compatible.
 */
import { describe, it, expect } from "vitest";
import type { GeneratedPrecondition, GeneratedInitializeResult, GeneratedCapabilities, GeneratedServerInfo, GeneratedSessionState, GeneratedClientInfo } from "../src/types";
import type { Precondition } from "../src/types.content";

describe("ts-rs generated types", () => {
  it("GeneratedPrecondition should be importable", () => {
    const p: GeneratedPrecondition = { tagName: "button", textContains: null, attributes: null };
    expect(p.tagName).toBe("button");
  });

  it("GeneratedPrecondition fields should match Precondition shape", () => {
    const p: GeneratedPrecondition = { tagName: "button", textContains: null, attributes: null };
    const hp: Precondition = { tagName: p.tagName ?? undefined, textContains: p.textContains ?? undefined, attributes: p.attributes ?? undefined };
    expect(hp.tagName).toBe("button");
    expect(hp.attributes).toBeUndefined();
  });

  it("GeneratedInitializeResult should be importable and structurally sound", () => {
    const r: GeneratedInitializeResult = {
      sessionId: "s1",
      protocolVersion: "1.0",
      negotiatedVersion: "1.0",
      serverInfo: { name: "brp", version: "0.6.0" },
      capabilities: { features: [], actions: [], treeDeltaSupported: false, multiSession: false },
    };
    expect(r.sessionId).toBe("s1");
    expect(r.capabilities.treeDeltaSupported).toBe(false);
  });
});
