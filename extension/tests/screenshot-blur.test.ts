/**
 * Tests for E5 Screenshot Blur.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import {
  buildSensitiveSelector, findSensitiveElements, shouldBlur, applyBlur,
} from "../src/screenshot-blur";
import type { ScreenshotBlurConfig } from "../src/permissions/config";

const baseConfig: ScreenshotBlurConfig = {
  gate: "always", fieldTypes: ["password", "creditCard"], customSelectors: [],
};

describe("buildSensitiveSelector", () => {
  it("should build selector for password only", () => {
    expect(buildSensitiveSelector({ ...baseConfig, fieldTypes: ["password"] })).toContain('input[type="password"]');
  });
  it("should build selector for multiple field types", () => {
    const sel = buildSensitiveSelector({ ...baseConfig, fieldTypes: ["password", "cvv", "email"] });
    expect(sel).toContain('input[type="password"]');
    expect(sel).toContain('input[name*="cvv" i]');
    expect(sel).toContain('input[type="email"]');
  });
  it("should include custom selectors", () => {
    expect(buildSensitiveSelector({ ...baseConfig, fieldTypes: [], customSelectors: [".secret", "#api"] })).toBe(".secret, #api");
  });
  it("should return empty string for empty config", () => {
    expect(buildSensitiveSelector({ ...baseConfig, fieldTypes: [], customSelectors: [] })).toBe("");
  });
});

describe("findSensitiveElements", () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM(`<!DOCTYPE html><body>
      <input type="text" id="name"><input type="password" id="pwd">
      <input type="email" id="mail"><input name="credit_card_number" id="cc">
      <button id="btn">Submit</button></body>`);
    globalThis.document = dom.window.document;
  });
  it("finds password fields", () => {
    expect(findSensitiveElements({ ...baseConfig, fieldTypes: ["password"] })[0].id).toBe("pwd");
  });
  it("finds credit card fields by name", () => {
    expect(findSensitiveElements({ ...baseConfig, fieldTypes: ["creditCard"] })[0].id).toBe("cc");
  });
  it("finds email fields", () => {
    expect(findSensitiveElements({ ...baseConfig, fieldTypes: ["email"] })[0].id).toBe("mail");
  });
  it("finds multiple field types", () => {
    expect(findSensitiveElements({ ...baseConfig, fieldTypes: ["password", "email"] }).length).toBe(2);
  });
  it("finds custom selectors", () => {
    expect(findSensitiveElements({ ...baseConfig, fieldTypes: [], customSelectors: ["#btn"] })[0].id).toBe("btn");
  });
  it("returns empty when no matches", () => {
    expect(findSensitiveElements({ ...baseConfig, fieldTypes: ["ssn"] }).length).toBe(0);
  });
});

describe("shouldBlur", () => {
  it("false when gate=never", () => {
    expect(shouldBlur({ ...baseConfig, gate: "never", fieldTypes: ["password"] })).toBe(false);
  });
  it("true when gate=always and fieldTypes non-empty", () => {
    expect(shouldBlur(baseConfig)).toBe(true);
  });
  it("false when fieldTypes empty and no custom", () => {
    expect(shouldBlur({ ...baseConfig, fieldTypes: [], customSelectors: [] })).toBe(false);
  });
  it("true when gate=ask and fieldTypes non-empty", () => {
    expect(shouldBlur({ ...baseConfig, gate: "ask" })).toBe(true);
  });
});

describe("applyBlur", () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM(`<!DOCTYPE html><body><input type="password" id="pwd"><input type="text" id="name"></body>`);
    globalThis.document = dom.window.document;
    (dom.window.HTMLElement.prototype as any).scrollIntoView = () => {};
  });
  it("adds blur class to sensitive elements", () => {
    const cleanup = applyBlur({ ...baseConfig, fieldTypes: ["password"] });
    expect(dom.window.document.getElementById("pwd")!.classList.contains("brp-screenshot-blur")).toBe(true);
    cleanup();
  });
  it("does not blur non-sensitive elements", () => {
    const cleanup = applyBlur({ ...baseConfig, fieldTypes: ["password"] });
    expect(dom.window.document.getElementById("name")!.classList.contains("brp-screenshot-blur")).toBe(false);
    cleanup();
  });
  it("cleanup removes blur class", () => {
    const cleanup = applyBlur({ ...baseConfig, fieldTypes: ["password"] });
    expect(dom.window.document.getElementById("pwd")!.classList.contains("brp-screenshot-blur")).toBe(true);
    cleanup();
    expect(dom.window.document.getElementById("pwd")!.classList.contains("brp-screenshot-blur")).toBe(false);
  });
  it("injects blur style once (idempotent)", () => {
    const c1 = applyBlur({ ...baseConfig, fieldTypes: ["password"] });
    const c2 = applyBlur({ ...baseConfig, fieldTypes: ["password"] });
    expect(dom.window.document.querySelectorAll("#brp-screenshot-blur-style").length).toBe(1);
    c1(); c2();
  });
});
