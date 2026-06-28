/**
 * BRP Content Script
 *
 * Handles DOM interaction actions dispatched from the background script.
 * Runs in page context via manifest.json content_scripts.
 */

import type {
  ContentMessage,
  ContentResult,
  ContentError,
  Modifiers,
} from "./types.content";
import { validatePrecondition } from "./precondition";
import type { ITreeAPI } from "./types.content";
import {
  isHTMLElement,
  isHTMLInputElement,
  isHTMLSelectElement,
  isHTMLTextAreaElement,
} from "./types.content";

const itree: ITreeAPI = window.__BRP_ITREE__;

// ─── Helpers ───

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModifiers(parts: string[]): { mainKey: string | null; modifiers: Modifiers } {
  const modifiers: Modifiers = {
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  };

  let mainKey: string | null = null;
  for (const part of parts) {
    const p = part.trim();
    const lower = p.toLowerCase();
    if (lower === "ctrl" || lower === "control") modifiers.ctrlKey = true;
    else if (lower === "shift") modifiers.shiftKey = true;
    else if (lower === "alt") modifiers.altKey = true;
    else if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super")
      modifiers.metaKey = true;
    else mainKey = p;
  }

  return { mainKey, modifiers };
}

// ─── Sensitive Field Detection ───

const SENSITIVE_INPUT_TYPES = new Set(["password", "hidden"]);

const SENSITIVE_KEYWORDS = [
  "password", "passwd", "secret", "cvv", "csc", "ccv",
  "ssn", "otp", "pin", "creditcard", "credit-card", "cc-number",
  "cardnumber", "securitycode", "verification",
] as const;

function isSensitiveElement(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "INPUT" && isHTMLInputElement(el)) {
    if (SENSITIVE_INPUT_TYPES.has((el.type ?? "").toLowerCase())) return true;
  }

  const autocomplete = el.getAttribute("autocomplete") ?? "";
  if (["current-password", "new-password", "cc-number", "cc-csc"].includes(autocomplete)) return true;

  const name = (el instanceof HTMLElement && "name" in el && typeof el.name === "string")
    ? el.name : el.getAttribute("name") ?? "";
  const id = el.id ?? "";
  const placeholder = el.getAttribute("placeholder") ?? "";

  const nameIdPlaceholder = [name, id, placeholder].join(" ").toLowerCase();
  return SENSITIVE_KEYWORDS.some((kw: string) => nameIdPlaceholder.includes(kw));
}

// ─── Error Helpers ───

function elementNotFound(): ContentError {
  return { error: "Element not found", errorCode: "BRP_TARGET_NOT_FOUND" };
}

function invalidParams(msg: string): ContentError {
  return { error: msg, errorCode: "BRP_INVALID_PARAMS" };
}

// ─── Action Implementations ───

function doClick(msg: ContentMessage): ContentResult {
  const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
  if (!el || !isHTMLElement(el)) return elementNotFound();

  const preErr = validatePrecondition(el, msg.precondition);
  if (preErr) return preErr;

  el.scrollIntoView({ behavior: "smooth", block: "center" });

  const rect = el.getBoundingClientRect();
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const topEl = document.elementFromPoint(centerX, centerY);
  if (topEl && topEl !== el && !el.contains(topEl)) {
    return {
      error: "Element is obscured",
      errorCode: "BRP_ELEMENT_INTERSECTED",
      retriable: true,
      recoveryHint: "scroll_into_view",
    };
  }

  el.click();

  setTimeout(() => {
    browser.runtime
      .sendMessage({
        type: "brp-event",
        event: "domChanged",
        params: {
          revision: itree.getRevision(),
          reason: "click",
        },
      })
      .catch(() => {
        /* suppress if background disconnected */
      });
  }, 300);

  return { success: true, matchedSelector: { type: "nodeId" } };
}

function doType(msg: ContentMessage): ContentResult {
  const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
  if (!el || !isHTMLElement(el)) return elementNotFound();

  const preErr = validatePrecondition(el, msg.precondition);
  if (preErr) return preErr;

  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.focus();

  const text = msg.text ?? "";

  for (const char of text) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));

    if (isHTMLInputElement(el) || isHTMLTextAreaElement(el)) {
      const start = el.selectionStart ?? 0;
      el.value =
        el.value.slice(0, start) + char + el.value.slice(el.selectionEnd ?? start);
      el.selectionStart = el.selectionEnd = start + 1;
    } else if (el.contentEditable === "true") {
      document.execCommand("insertText", false, char);
    }

    el.dispatchEvent(new InputEvent("input", { data: char, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
  }

  el.dispatchEvent(new Event("change", { bubbles: true }));

  return { success: true, typed: text.length };
}

function doFill(msg: ContentMessage): ContentResult {
  const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
  if (!el || !isHTMLElement(el)) return elementNotFound();

  const preErr = validatePrecondition(el, msg.precondition);
  if (preErr) return preErr;

  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.focus();

  const text = msg.text ?? "";

  if (isHTMLInputElement(el) || isHTMLTextAreaElement(el)) {
    el.value = text;
  } else if (el.contentEditable === "true") {
    el.textContent = text;
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));

  return { success: true, filled: text.length };
}

function doExecuteScript(msg: ContentMessage): ContentResult {
  if (!msg.code) return { error: "No code provided" };
  if (typeof msg.code !== "string") return invalidParams("Code must be a string");
  if (msg.code.length > 1048576) return invalidParams("Script too large (max 1MB)");

  try {
    const fn = new Function(msg.code);
    const result = fn();

    let resultStr: string;
    try {
      resultStr = JSON.stringify(result);
    } catch {
      resultStr = String(result);
    }

    if (resultStr && resultStr.length > 1048576) {
      return {
        success: true,
        result: "[RESULT TRUNCATED — exceeded 1MB]",
        truncated: true,
        originalSize: resultStr.length,
      };
    }

    return { success: true, result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, errorCode: "BRP_SCRIPT_ERROR" };
  }
}

function doScroll(msg: ContentMessage): ContentResult {
  if (msg.selector || msg.nodeId) {
    const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
    if (!el || !isHTMLElement(el)) return elementNotFound();
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    return { success: true };
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
  return { success: true };
}

function doHover(msg: ContentMessage): ContentResult {
  const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
  if (!el || !isHTMLElement(el)) return elementNotFound();

  const preErr = validatePrecondition(el, msg.precondition);
  if (preErr) return preErr;

  el.scrollIntoView({ behavior: "smooth", block: "center" });

  const rect = el.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;

  el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, clientX: x, clientY: y }));
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));

  return { success: true };
}

function doSelect(msg: ContentMessage): ContentResult {
  const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
  if (!el || !isHTMLSelectElement(el)) {
    if (!el) return elementNotFound();
    return { error: "Element is not a <select>", errorCode: "BRP_INVALID_TARGET" };
  }

  const preErr = validatePrecondition(el, msg.precondition);
  if (preErr) return preErr;

  const values = msg.values ?? (msg.value !== undefined ? [msg.value] : []);

  if (values.length === 0) {
    return invalidParams("No value(s) provided for select");
  }

  if (!el.multiple) {
    for (const opt of el.options) opt.selected = false;
  }

  let matched = 0;
  for (const opt of el.options) {
    if (values.includes(opt.value) || values.includes(opt.text)) {
      opt.selected = true;
      matched++;
      if (!el.multiple) break;
    }
  }

  if (matched === 0) {
    return { error: "No matching option found", errorCode: "BRP_TARGET_NOT_FOUND" };
  }

  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { success: true, selected: matched };
}

function doGetAttribute(msg: ContentMessage): ContentResult {
  const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
  if (!el || !isHTMLElement(el)) return elementNotFound();

  const attrName = msg.attribute;
  if (!attrName) return { error: "No attribute name provided" };

  const sensitiveAttrs = new Set(["value", "textContent", "innerText", "innerHTML"]);
  if (sensitiveAttrs.has(attrName) && isSensitiveElement(el)) {
    return { success: true, value: "[REDACTED]", redacted: true, reason: "sensitive field" };
  }

  switch (attrName) {
    case "textContent":
      return { success: true, value: el.textContent };
    case "innerText":
      return { success: true, value: el.innerText };
    case "innerHTML":
      return { success: true, value: el.innerHTML };
    case "value":
      if (isHTMLInputElement(el) || isHTMLTextAreaElement(el) || isHTMLSelectElement(el)) {
        return { success: true, value: el.value };
      }
      return { success: true, value: null };
    case "checked":
      if (isHTMLInputElement(el)) return { success: true, value: el.checked };
      return { success: true, value: null };
    case "disabled":
      if (isHTMLInputElement(el)) return { success: true, value: el.disabled };
      return { success: true, value: null };
    default:
      return { success: true, value: el.getAttribute(attrName) };
  }
}

function doKeyboardPress(msg: ContentMessage): ContentResult {
  const key = msg.key;
  if (!key) return { error: "No key provided" };

  const parts = key.split("+");
  const { mainKey, modifiers } = parseModifiers(parts);

  if (!mainKey) return { error: "No main key in combination" };

  let el: Element;
  if (msg.selector || msg.nodeId) {
    const found = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
    if (!found || !isHTMLElement(found)) return elementNotFound();
    el = found;
  } else {
    el = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  }

  const opts: KeyboardEventInit = {
    key: mainKey,
    code: mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  };

  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  el.dispatchEvent(new KeyboardEvent("keypress", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));

  return { success: true, key: mainKey, modifiers };
}

function doWaitForSelector(msg: ContentMessage): Promise<ContentResult> {
  const selector = msg.css ?? (typeof msg.selector?.value === "string" ? msg.selector.value : undefined);
  if (!selector) return Promise.resolve({ error: "No CSS selector provided" });

  const timeout = msg.timeout ?? 10000;

  return new Promise<ContentResult>((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve({ success: true, found: true });
      return;
    }

    let resolved = false;
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el && !resolved) {
        resolved = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve({ success: true, found: true });
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        observer.disconnect();
        resolve({ error: "Timeout waiting for selector", errorCode: "BRP_TIMEOUT" });
      }
    }, timeout);
  });
}

// ─── Content Script Entry Point ───

browser.runtime.onMessage.addListener(
  async (msg: unknown): Promise<ContentResult> => {
    if (!isObject(msg) || typeof msg.action !== "string") {
      return { error: "Invalid message format" };
    }
    const contentMsg = msg as unknown as ContentMessage;

    try {
      switch (contentMsg.action) {
        case "getITree":
          return itree.buildInteractionTree() as unknown as ContentResult;

        case "click":
          return doClick(contentMsg);

        case "type":
          return doType(contentMsg);

        case "fill":
          return doFill(contentMsg);

        case "scroll":
          return doScroll(contentMsg);

        case "hover":
          return doHover(contentMsg);

        case "select":
          return doSelect(contentMsg);

        case "getAttribute":
          return doGetAttribute(contentMsg);

        case "keyboardPress":
          return doKeyboardPress(contentMsg);

        case "waitForSelector":
          return await doWaitForSelector(contentMsg);

        case "executeScript":
          return doExecuteScript(contentMsg);

        default:
          return { error: `Unknown action: ${contentMsg.action}` };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message };
    }
  },
);

// ─── MutationObserver for DOM changes ───

if (document.body) {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver((mutations: MutationRecord[]) => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      browser.runtime
        .sendMessage({
          type: "brp-event",
          event: "domChanged",
          params: {
            revision: itree.getRevision(),
            mutationCount: mutations.length,
          },
        })
        .catch(() => {
          /* suppress if background disconnected */
        });
    }, 500);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "disabled", "value", "checked"],
  });
}
