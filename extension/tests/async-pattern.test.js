/**
 * Async pattern regression tests.
 *
 * The v0.3.0 async listener bug: content.js used `sendResponse()` + `return true`
 * in an async message listener, which caused the response to be lost in Firefox.
 *
 * The correct pattern for Firefox (MV2) is:
 *   browser.runtime.onMessage.addListener(async (msg) => { return result; });
 *
 * The BROKEN pattern was:
 *   browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
 *     doAsyncWork().then(r => sendResponse(r));
 *     return true;  // tells Firefox to wait, but sendResponse is broken with async
 *   });
 *
 * These tests parse the source code to ensure the broken pattern is never reintroduced.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, "..");

// ─── content.js async pattern ───

describe("content.js message listener async pattern", () => {
  const contentSource = readFileSync(
    resolve(extensionRoot, "content/content.js"),
    "utf-8"
  );

  it("uses an async listener (returns a Promise, not sendResponse + return true)", () => {
    // The listener should be declared as `async` — this is the correct pattern.
    // Match: addListener(async (msg) => { or addListener(async function(msg) {
    const asyncListenerPattern = /onMessage\.addListener\(\s*async\s/;
    expect(asyncListenerPattern.test(contentSource)).toBe(true);
  });

  it("does NOT call sendResponse in executable code", () => {
    // sendResponse is the second or third parameter in the listener callback.
    // If the listener is async, it should return a Promise — sendResponse is NOT needed.
    // We check for `sendResponse(` as a function call (ignoring comment mentions).
    // Strip single-line comments before checking.
    const codeOnly = contentSource.replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toContain("sendResponse(");
  });

  it("does NOT return true from the listener (broken keepalive pattern)", () => {
    // `return true` after sendResponse is the broken pattern that tells Firefox
    // "I'll respond asynchronously" but doesn't work with async listeners.
    //
    // Extract just the listener callback body and check it doesn't contain `return true;`.
    // Other functions (like isSensitiveElement) legitimately use `return true;`.
    const listenerStart = contentSource.indexOf("onMessage.addListener(async");
    expect(listenerStart).toBeGreaterThan(0);

    // Find the matching closing of the listener arrow function
    // by counting braces from the opening { after the =>
    const arrowIdx = contentSource.indexOf("=>", listenerStart);
    const openBrace = contentSource.indexOf("{", arrowIdx);
    let depth = 1;
    let pos = openBrace + 1;
    while (depth > 0 && pos < contentSource.length) {
      if (contentSource[pos] === "{") depth++;
      else if (contentSource[pos] === "}") depth--;
      pos++;
    }
    const listenerBody = contentSource.slice(openBrace, pos);

    // The listener body should NOT contain `return true;`
    expect(listenerBody).not.toMatch(/return\s+true\s*;/);
  });

  it("handles all actions via return values (not callbacks)", () => {
    // Every case in the switch should use `return` to send results
    const returnStatements = contentSource.match(/^\s*return\s+/gm) || [];
    // There should be many return statements (one per case + error handling)
    expect(returnStatements.length).toBeGreaterThanOrEqual(10);
  });
});

// ─── background.js async pattern ───

describe("background.ts message handler pattern", () => {
  const backgroundSource = readFileSync(
    resolve(extensionRoot, "src/background.ts"),
    "utf-8"
  );

  it("handleRequest is an async function (returns a Promise)", () => {
    // handleRequest should be async so it can await handlers
    expect(backgroundSource).toMatch(/async\s+function\s+handleRequest/);
  });

  it("action handlers return results (not use sendResponse)", () => {
    // Background handlers should return values, not use a callback pattern
    expect(backgroundSource).not.toContain("sendResponse");
  });

  it("delegates validation to BRP module", () => {
    // Ensure background.ts imports and uses typed validation helpers
    expect(backgroundSource).toContain("validateUrl(");
    expect(backgroundSource).toContain("validateTabId(");
    expect(backgroundSource).toContain("validateSelector(");
  });

  it("uses BRP.shouldBlockNavigation for the sentinel", () => {
    expect(backgroundSource).toContain("shouldBlockNavigation(");
  });

  it("uses BRP.isRestrictedUrl for content script messaging", () => {
    expect(backgroundSource).toContain("isRestrictedUrl(");
  });
});

// ─── handlers.js is loaded before background.js ───

describe("manifest.json script ordering", () => {
  const manifestSource = readFileSync(
    resolve(extensionRoot, "manifest.json"),
    "utf-8"
  );
  const manifest = JSON.parse(manifestSource);

  it("loads built handlers before built background in background scripts", () => {
    const scripts = manifest.background.scripts;
    const handlersIdx = scripts.indexOf("dist/handlers.js");
    const backgroundIdx = scripts.indexOf("dist/background.js");

    expect(handlersIdx).toBeGreaterThanOrEqual(0);
    expect(backgroundIdx).toBeGreaterThanOrEqual(0);
    expect(handlersIdx).toBeLessThan(backgroundIdx);
  });

  it("still loads as MV2 (manifest_version: 2)", () => {
    expect(manifest.manifest_version).toBe(2);
  });
});
