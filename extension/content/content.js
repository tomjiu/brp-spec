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
      });
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

    try {
      // eslint-disable-next-line no-eval
      const result = eval(msg.code);
      return { success: true, result: result };
    } catch (err) {
      return { error: err.message, errorCode: "BRP_SCRIPT_ERROR" };
    }
  }

  // --- MutationObserver for DOM changes ---

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
      });
    }, 500);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "disabled", "value", "checked"]
  });
})();
