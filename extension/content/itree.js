/**
 * BRP Interaction Tree Builder
 * Walks the DOM and produces a structured Interaction Tree (ITree)
 * that the AI client can reason about.
 */

(function () {
  "use strict";

  let currentRevision = 0;
  let nodeIdCounter = 0;
  let nodeMap = new Map(); // nodeId -> element

  // Interactive element roles mapping
  const ROLE_MAP = {
    A: "link",
    BUTTON: "button",
    INPUT: "textbox",
    TEXTAREA: "textbox",
    SELECT: "combobox",
    FORM: "form",
    IMG: "image",
    H1: "heading", H2: "heading", H3: "heading",
    H4: "heading", H5: "heading", H6: "heading",
    TABLE: "table",
    UL: "list", OL: "list",
    LI: "listitem",
    NAV: "navigation",
    MAIN: "main",
    HEADER: "banner",
    FOOTER: "contentinfo",
    ASIDE: "complementary",
    ARTICLE: "article",
    SECTION: "region",
    DETAILS: "group",
    DIALOG: "dialog",
    LABEL: "label",
  };

  const INPUT_TYPE_ROLE = {
    button: "button",
    submit: "button",
    reset: "button",
    checkbox: "checkbox",
    radio: "radio",
    file: "button",
    hidden: null,
    image: "button",
    range: "slider",
    color: "colorwell",
    date: "date",
    time: "time",
    search: "searchbox",
  };

  /**
   * Check if an element is interactive / meaningful for the ITree
   */
  function isInteractive(el) {
    if (!el || el.nodeType !== 1) return false;

    const tag = el.tagName;
    const style = window.getComputedStyle(el);

    // Skip hidden elements
    if (style.display === "none" || style.visibility === "hidden") return false;

    // Always include interactive elements
    if (ROLE_MAP[tag]) return true;
    if (el.getAttribute("role")) return true;
    if (el.onclick || el.getAttribute("onclick")) return true;
    if (el.tabIndex >= 0) return true;
    if (el.contentEditable === "true") return true;

    // Include elements with text content that might be clickable
    if (el.children.length === 0 && el.textContent?.trim()) return true;

    return false;
  }

  /**
   * Get the accessible name for an element
   */
  function getAccessibleName(el) {
    // aria-label
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");

    // aria-labelledby
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/);
      const texts = ids.map(id => {
        const labelEl = document.getElementById(id);
        return labelEl ? labelEl.textContent.trim() : "";
      }).filter(Boolean);
      if (texts.length) return texts.join(" ");
    }

    // title attribute
    if (el.getAttribute("title")) return el.getAttribute("title");

    // For inputs, check associated label
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return label.textContent.trim();
    }

    // Placeholder for text inputs
    if (el.placeholder) return el.placeholder;

    // alt for images
    if (el.alt) return el.alt;

    // Text content (trimmed)
    const text = el.textContent?.trim();
    if (text && text.length < 200) return text;

    return "";
  }

  /**
   * Determine the role for an element
   */
  function getRole(el) {
    // Explicit ARIA role
    const ariaRole = el.getAttribute("role");
    if (ariaRole) return ariaRole;

    const tag = el.tagName;

    // Special handling for inputs
    if (tag === "INPUT") {
      const type = (el.type || "text").toLowerCase();
      return INPUT_TYPE_ROLE[type] || "textbox";
    }

    return ROLE_MAP[tag] || "generic";
  }

  /**
   * Build an ITree node from a DOM element
   */
  function buildNode(el, depth) {
    if (!isInteractive(el)) return null;

    const nodeId = `node_${++nodeIdCounter}`;
    nodeMap.set(nodeId, el);

    const rect = el.getBoundingClientRect();
    const role = getRole(el);
    const name = getAccessibleName(el);

    const node = {
      nodeId,
      role,
      name,
      tag: el.tagName.toLowerCase(),
      visible: rect.width > 0 && rect.height > 0,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };

    // Add value for inputs
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      node.value = el.value || "";
      node.checked = el.checked || false;
      node.disabled = el.disabled || false;
      node.readOnly = el.readOnly || false;
    }

    // Add href for links
    if (el.tagName === "A" && el.href) {
      node.href = el.href;
    }

    // Add src for images
    if (el.tagName === "IMG" && el.src) {
      node.src = el.src;
    }

    // Add type for inputs
    if (el.tagName === "INPUT") {
      node.inputType = el.type || "text";
    }

    // Build children
    const children = [];
    for (const child of el.children) {
      const childNode = buildNode(child, depth + 1);
      if (childNode) children.push(childNode);
    }
    if (children.length > 0) {
      node.children = children;
    }

    return node;
  }

  /**
   * Build the complete Interaction Tree for the current document
   */
  function buildInteractionTree() {
    nodeIdCounter = 0;
    nodeMap.clear();
    currentRevision++;

    const root = buildNode(document.body, 0);

    return {
      revision: currentRevision,
      url: window.location.href,
      title: document.title,
      root: root || { nodeId: "node_0", role: "generic", name: "", children: [] },
      nodeCount: nodeIdCounter
    };
  }

  /**
   * Find element by selector chain (with fallback)
   */
  function findElement(selector, selectors, nodeId) {
    // By nodeId
    if (nodeId && nodeMap.has(nodeId)) {
      return nodeMap.get(nodeId);
    }

    // By selector array (fallback chain)
    if (selectors && Array.isArray(selectors)) {
      for (const sel of selectors) {
        const el = findBySelector(sel);
        if (el) return el;
      }
    }

    // By single selector
    if (selector) {
      return findBySelector(selector);
    }

    return null;
  }

  function findBySelector(sel) {
    if (!sel || !sel.type) return null;

    switch (sel.type) {
      case "nodeId":
        return nodeMap.get(sel.value) || null;

      case "css":
        try {
          return document.querySelector(sel.value);
        } catch {
          return null;
        }

      case "xpath": {
        const result = document.evaluate(sel.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue;
      }

      case "role": {
        const { role, name } = sel.value || {};
        const all = document.querySelectorAll(`[role="${role}"], ${Object.entries(ROLE_MAP).find(([, v]) => v === role)?.[0] || "*"}`);
        for (const el of all) {
          if (getRole(el) === role && getAccessibleName(el) === name) return el;
        }
        return null;
      }

      case "text": {
        const text = sel.value;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const el = walker.currentNode;
          if (el.textContent?.trim() === text && el.children.length === 0) return el;
        }
        return null;
      }

      case "coordinate": {
        const { x, y } = sel.value || {};
        return document.elementFromPoint(x, y);
      }

      default:
        return null;
    }
  }

  // Expose to content.js
  window.__BRP_ITREE__ = {
    buildInteractionTree,
    findElement,
    getRevision: () => currentRevision
  };
})();
