/**
 * BRP Content Script
 * Handles DOM interaction actions from the background script.
 */

(function () {
  "use strict";

  const itree = window.__BRP_ITREE__;

  // Listen for messages from background
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      let result;

      switch (msg.action) {
        case "getITree":
          result = itree.buildInteractionTree();
          break;

        case "click":
          result = doClick(msg);
          break;

        case "type":
          result = doType(msg);
          break;

        case "fill":
          result = doFill(msg);
          break;

        case "scroll":
          result = doScroll(msg);
          break;

        case "hover":
          result = doHover(msg);
          break;

        case "select":
          result = doSelect(msg);
          break;

        case "getAttribute":
          result = doGetAttribute(msg);
          break;

        case "keyboardPress":
          result = doKeyboardPress(msg);
          break;

        case "waitForSelector":
          result = await doWaitForSelector(msg);
          break;

        case "executeScript":
          result = doExecuteScript(msg);
          break;

        default:
          result = { error: "Unknown action: " + msg.action };
      }

      sendResponse(result);
    } catch (err) {
      sendResponse({ error: err.message });
    }

    return true; // Keep message channel open for async
  });

  // --- Action Implementations ---

  function doClick(msg) {
    const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
    if (!el) {
      return { error: "Element not found", errorCode: "BRP_TARGET_NOT_FOUND" };
    }

    // Scroll into view
    el.scrollIntoView({ behavior: "smooth", block: "center" });

    // Check if element is obscured
    const rect = el.getBoundingClientRect();
    const topEl = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (topEl && topEl !== el && !el.contains(topEl)) {
      return {
        error: "Element is obscured",
        errorCode: "BRP_ELEMENT_INTERSECTED",
        retriable: true,
        recoveryHint: "scroll_into_view"
      };
    }

    // Perform click
    el.click();

    // Notify background of DOM change
    setTimeout(() => {
      browser.runtime.sendMessage({
        type: "brp-event",
        event: "domChanged",
        params: {
          revision: itree.getRevision(),
          reason: "click"
        }
      }).catch(() => {}); // suppress if background disconnected
    }, 300);

    return { success: true, matchedSelector: { type: "nodeId" } };
  }

  function doType(msg) {
    const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
    if (!el) {
      return { error: "Element not found", errorCode: "BRP_TARGET_NOT_FOUND" };
    }

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus();

    const text = msg.text || "";

    // Simulate typing character by character
    for (const char of text) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));

      // Insert character
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const start = el.selectionStart || 0;
        el.value = el.value.slice(0, start) + char + el.value.slice(el.selectionEnd || start);
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

  function doFill(msg) {
    const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
    if (!el) {
      return { error: "Element not found", errorCode: "BRP_TARGET_NOT_FOUND" };
    }

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus();

    const text = msg.text || "";

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      el.value = text;
    } else if (el.contentEditable === "true") {
      el.textContent = text;
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    return { success: true, filled: text.length };
  }

  function doExecuteScript(msg) {
    if (!msg.code) {
      return { error: "No code provided" };
    }

    if (typeof msg.code !== "string") {
      return { error: "Code must be a string", errorCode: "BRP_INVALID_PARAMS" };
    }

    // Enforce size limit to prevent memory exhaustion
    if (msg.code.length > 1048576) {
      return { error: "Script too large (max 1MB)", errorCode: "BRP_INVALID_PARAMS" };
    }

    try {
      // Use Function constructor for slightly better isolation
      // (creates a new scope, doesn't have access to local variables)
      const fn = new Function(msg.code);
      const result = fn();
      return { success: true, result: result };
    } catch (err) {
      return { error: err.message, errorCode: "BRP_SCRIPT_ERROR" };
    }
  }

  // --- New Core Actions (RFC0002) ---

  function doScroll(msg) {
    if (msg.selector || msg.nodeId) {
      const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
      if (!el) {
        return { error: "Element not found", errorCode: "BRP_TARGET_NOT_FOUND" };
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return { success: true };
    }
    // No selector: scroll to top
    window.scrollTo({ top: 0, behavior: "smooth" });
    return { success: true };
  }

  function doHover(msg) {
    const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
    if (!el) {
      return { error: "Element not found", errorCode: "BRP_TARGET_NOT_FOUND" };
    }

    el.scrollIntoView({ behavior: "smooth", block: "center" });

    const rect = el.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;

    // Dispatch mouseenter and mouseover events
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));

    return { success: true };
  }

  function doSelect(msg) {
    const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
    if (!el) {
      return { error: "Element not found", errorCode: "BRP_TARGET_NOT_FOUND" };
    }

    if (el.tagName !== "SELECT") {
      return { error: "Element is not a <select>", errorCode: "BRP_INVALID_TARGET" };
    }

    const value = msg.value;
    const values = msg.values || (value !== undefined ? [value] : []);

    if (values.length === 0) {
      return { error: "No value(s) provided for select", errorCode: "BRP_INVALID_PARAMS" };
    }

    // Clear existing selections for non-multi select
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

  function doGetAttribute(msg) {
    const el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
    if (!el) {
      return { error: "Element not found", errorCode: "BRP_TARGET_NOT_FOUND" };
    }

    const attrName = msg.attribute;
    if (!attrName) {
      return { error: "No attribute name provided" };
    }

    // Special properties that aren't attributes
    if (attrName === "textContent") return { success: true, value: el.textContent };
    if (attrName === "innerText") return { success: true, value: el.innerText };
    if (attrName === "innerHTML") return { success: true, value: el.innerHTML };
    if (attrName === "value") return { success: true, value: el.value };
    if (attrName === "checked") return { success: true, value: el.checked };
    if (attrName === "disabled") return { success: true, value: el.disabled };

    const value = el.getAttribute(attrName);
    return { success: true, value: value };
  }

  function doKeyboardPress(msg) {
    const key = msg.key;
    if (!key) {
      return { error: "No key provided" };
    }

    // Parse key combination: "Control+Shift+a", "Alt+F4", "Enter"
    const parts = key.split("+");
    const modifiers = {
      ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    };

    let mainKey = null;
    for (const part of parts) {
      const p = part.trim();
      const lower = p.toLowerCase();
      if (lower === "ctrl" || lower === "control") modifiers.ctrlKey = true;
      else if (lower === "shift") modifiers.shiftKey = true;
      else if (lower === "alt") modifiers.altKey = true;
      else if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super") modifiers.metaKey = true;
      else mainKey = p;
    }

    if (!mainKey) {
      return { error: "No main key in combination" };
    }

    // Find target element (focused element or specified)
    let el = null;
    if (msg.selector || msg.nodeId) {
      el = itree.findElement(msg.selector, msg.selectors, msg.nodeId);
      if (!el) {
        return { error: "Element not found", errorCode: "BRP_TARGET_NOT_FOUND" };
      }
    } else {
      el = document.activeElement || document.body;
    }

    const opts = {
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

  function doWaitForSelector(msg) {
    const css = msg.css || msg.selector?.value;
    if (!css) {
      return Promise.resolve({ error: "No CSS selector provided" });
    }

    const timeout = msg.timeout || 10000;

    return new Promise((resolve) => {
      // Check immediately
      const existing = document.querySelector(css);
      if (existing) {
        resolve({ success: true, found: true });
        return;
      }

      let resolved = false;
      const observer = new MutationObserver(() => {
        const el = document.querySelector(css);
        if (el && !resolved) {
          resolved = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve({ success: true, found: true });
        }
      });

      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          observer.disconnect();
          resolve({ success: false, found: false, error: "Timeout waiting for selector" });
        }
      }, timeout);
    });
  }

  // --- MutationObserver for DOM changes ---

  if (document.body) {
    let debounceTimer = null;
    const observer = new MutationObserver((mutations) => {
      // Debounce: wait 500ms after last mutation before reporting
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        browser.runtime.sendMessage({
          type: "brp-event",
          event: "domChanged",
          params: {
            revision: itree.getRevision(),
            mutationCount: mutations.length
          }
        }).catch(() => {}); // suppress if background disconnected
      }, 500);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "disabled", "value", "checked"]
    });
  }
})();
