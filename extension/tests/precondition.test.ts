/**
 * Tests for validatePrecondition (E3 DOM Precondition Validation).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { validatePrecondition } from "../src/precondition";

let dom: JSDOM;
let doc: Document;

describe("validatePrecondition", () => {
  beforeEach(() => {
    dom = new JSDOM(`<!DOCTYPE html><html><body>
      <button id="login-btn" data-testid="submit">Login</button>
      <a id="footer-link" href="/login">Login here</a>
      <div id="plain-div">Some content</div>
    </body></html>`);
    doc = dom.window.document;
  });

  it("should return null when no precondition is set (pass-through)", () => {
    const el = doc.getElementById("login-btn")!;
    const result = validatePrecondition(el, undefined);
    expect(result).toBeNull();
  });

  it("should pass when tagName matches (case-insensitive)", () => {
    const el = doc.getElementById("login-btn")!;
    const result = validatePrecondition(el, { tagName: "button" });
    expect(result).toBeNull();
  });

  it("should fail when tagName mismatches", () => {
    const el = doc.getElementById("footer-link")!; // <a>
    const result = validatePrecondition(el, { tagName: "BUTTON" });
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe("BRP_PRECONDITION_FAILED");
    expect(result!.error).toContain("tagName");
  });

  it("should pass when textContains matches", () => {
    const el = doc.getElementById("login-btn")!; // text: "Login"
    const result = validatePrecondition(el, { textContains: "Login" });
    expect(result).toBeNull();
  });

  it("should fail when textContains mismatches", () => {
    const el = doc.getElementById("plain-div")!; // text: "Some content"
    const result = validatePrecondition(el, { textContains: "Login" });
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe("BRP_PRECONDITION_FAILED");
    expect(result!.error).toContain("textContains");
  });

  it("should pass when attributes match", () => {
    const el = doc.getElementById("login-btn")!;
    const result = validatePrecondition(el, { attributes: { "data-testid": "submit" } });
    expect(result).toBeNull();
  });

  it("should fail when attribute value mismatches", () => {
    const el = doc.getElementById("footer-link")!; // href="/login"
    const result = validatePrecondition(el, { attributes: { "data-testid": "submit" } });
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe("BRP_PRECONDITION_FAILED");
  });

  it("should pass when all preconditions match", () => {
    const el = doc.getElementById("login-btn")!;
    const result = validatePrecondition(el, {
      tagName: "BUTTON",
      textContains: "Login",
      attributes: { "data-testid": "submit" },
    });
    expect(result).toBeNull();
  });

  it("should fail when one of multiple preconditions mismatches", () => {
    const el = doc.getElementById("footer-link")!; // <a>Login here</a>
    const result = validatePrecondition(el, {
      tagName: "BUTTON", // mismatch
      textContains: "Login", // matches
    });
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe("BRP_PRECONDITION_FAILED");
    expect(result!.error).toContain("tagName");
  });
});
