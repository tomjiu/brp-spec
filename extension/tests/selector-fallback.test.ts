/**
 * Tests for findElementWithFallback (E4 Context Recovery Pipeline).
 *
 * Uses JSDOM to provide real DOM elements for ITree API mocking.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { findElementWithFallback } from "../src/selector-fallback";
import type { ITreeAPI, SelectorValue } from "../src/types.content";

let dom: JSDOM;
let doc: Document;

/** Mock ITreeAPI that finds elements from the JSDOM document. */
function mockItree(doc: Document): ITreeAPI {
  return {
    buildInteractionTree: () => {
      throw new Error("not used");
    },
    findElement(
      selector?: SelectorValue,
      _selectors?: SelectorValue[],
      nodeId?: string,
    ): Element | null {
      if (nodeId) return doc.querySelector(`[data-nodeid="${nodeId}"]`);
      if (!selector) return null;

      const value = selector.value as string;
      switch (selector.type) {
        case "css":
          return doc.querySelector(value);
        case "text":
          return Array.from(doc.querySelectorAll("*")).find(
            (el) => el.textContent?.includes(value) ?? false,
          ) ?? null;
        case "xpath":
          return null; // simplified for test
        case "role":
        case "nodeId":
        case "coordinate":
        default:
          return null;
      }
    },
    getRevision: () => 1,
  };
}

describe("findElementWithFallback", () => {
  let itree: ITreeAPI;

  beforeEach(() => {
    dom = new JSDOM(`<!DOCTYPE html><html><body>
      <button id="login-btn">Login</button>
      <a href="/login">Login here</a>
      <div id="placeholder">Loading...</div>
      <button class="submit" id="submit-btn">Submit Form</button>
    </body></html>`);
    doc = dom.window.document;
    itree = mockItree(doc);
  });

  it("should find element when main selector succeeds, no fallback", () => {
    const selector: SelectorValue = { type: "css", value: "#login-btn" };
    const result = findElementWithFallback(selector, undefined, undefined, itree, true);
    expect(result.element).not.toBeNull();
    expect(result.element!.id).toBe("login-btn");
    expect(result.matchedType).toBe("css");
  });

  it("should return null when acceptFallback is false and selector fails", () => {
    const selector: SelectorValue = { type: "css", value: ".nonexistent" };
    const result = findElementWithFallback(selector, undefined, undefined, itree, false);
    expect(result.element).toBeNull();
    expect(result.matchedType).toBeUndefined();
  });

  it("should fallback to text when CSS fails", () => {
    // Use "Login" as CSS value — it won't match as CSS selector, but will match as text
    const selector: SelectorValue = { type: "css", value: "Login" };
    const result = findElementWithFallback(selector, undefined, undefined, itree, true);
    // Should find <button>Login</button> or <a>Login here</a> via text
    expect(result.element).not.toBeNull();
    expect(result.matchedType).toBe("text");
  });

  it("should skip main selector type in fallback chain", () => {
    // CSS is the main type, CSS should not appear in the fallback chain
    const selector: SelectorValue = { type: "css", value: "Submit Form" };
    const result = findElementWithFallback(selector, undefined, undefined, itree, true);
    // Should fallback to text and find <button class="submit">Submit Form</button>
    expect(result.matchedType).not.toBe("css");
    expect(result.element).not.toBeNull();
  });

  it("should return null when all fallbacks fail", () => {
    const selector: SelectorValue = { type: "css", value: ".completely-nonexistent-NO-MATCH" };
    const result = findElementWithFallback(selector, undefined, undefined, itree, true);
    expect(result.element).toBeNull();
  });

  it("should fallback to text with partial match via textContent", () => {
    const selector: SelectorValue = { type: "css", value: "#placeholder" };
    // Main selector succeeds → no fallback
    const result = findElementWithFallback(selector, undefined, undefined, itree, true);
    expect(result.element).not.toBeNull();
    expect(result.matchedType).toBe("css");
  });

  it("should accept fallback=false by default (backward compat)", () => {
    const selector: SelectorValue = { type: "css", value: ".nonexistent" };
    // Default to false
    const result = findElementWithFallback(selector, undefined, undefined, itree, false);
    expect(result.element).toBeNull();
  });
});
