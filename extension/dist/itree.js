"use strict";
(() => {
  // src/types.content.ts
  function isHTMLInputElement(el) {
    return el instanceof HTMLInputElement;
  }
  function isHTMLAnchorElement(el) {
    return el instanceof HTMLAnchorElement;
  }
  function isHTMLImageElement(el) {
    return el instanceof HTMLImageElement;
  }

  // src/itree.ts
  var currentRevision = 0;
  var nodeIdCounter = 0;
  var nodeMap = /* @__PURE__ */ new Map();
  var ROLE_MAP = {
    A: "link",
    BUTTON: "button",
    INPUT: "textbox",
    TEXTAREA: "textbox",
    SELECT: "combobox",
    FORM: "form",
    IMG: "image",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    TABLE: "table",
    UL: "list",
    OL: "list",
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
    LABEL: "label"
  };
  var INPUT_TYPE_ROLE = {
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
    search: "searchbox"
  };
  var SENSITIVE_KEYWORDS = [
    "password",
    "passwd",
    "secret",
    "cvv",
    "csc",
    "ccv",
    "ssn",
    "otp",
    "pin",
    "creditcard",
    "credit-card",
    "cc-number",
    "cardnumber",
    "securitycode",
    "verification"
  ];
  function isInteractive(el) {
    const tag = el.tagName;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (tag in ROLE_MAP) return true;
    if (el.getAttribute("role")) return true;
    const elAny = el;
    const clickHandler = elAny.onclick;
    if (clickHandler !== null && clickHandler !== void 0) return true;
    if (el.getAttribute("onclick")) return true;
    if (el instanceof HTMLElement && el.tabIndex >= 0) return true;
    if (el instanceof HTMLElement && el.contentEditable === "true") return true;
    if (el.children.length === 0 && el.textContent?.trim()) return true;
    return false;
  }
  function getAccessibleName(el) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/);
      const texts = ids.map((id) => {
        const labelEl = document.getElementById(id);
        return labelEl ? labelEl.textContent?.trim() ?? "" : "";
      }).filter(Boolean);
      if (texts.length) return texts.join(" ");
    }
    const title = el.getAttribute("title");
    if (title) return title;
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label instanceof HTMLElement && label.textContent) {
        return label.textContent.trim();
      }
    }
    if (isHTMLInputElement(el) && el.placeholder) return el.placeholder;
    if (isHTMLImageElement(el) && el.alt) return el.alt;
    const text = el.textContent?.trim();
    if (text && text.length < 200) return text;
    return "";
  }
  function getRole(el) {
    const ariaRole = el.getAttribute("role");
    if (ariaRole) return ariaRole;
    const tag = el.tagName;
    if (tag === "INPUT" && isHTMLInputElement(el)) {
      const type = (el.type || "text").toLowerCase();
      return INPUT_TYPE_ROLE[type] ?? "textbox";
    }
    return ROLE_MAP[tag] ?? "generic";
  }
  function buildNode(el, depth) {
    if (depth > 64) return null;
    const interactive = isInteractive(el);
    const children = [];
    for (const child of el.children) {
      const childNode = buildNode(child, depth + 1);
      if (childNode) children.push(childNode);
    }
    if (!interactive) {
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
      return {
        nodeId: `node_${++nodeIdCounter}`,
        role: "generic",
        name: "",
        tag: el.tagName.toLowerCase(),
        visible: true,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        children
      };
    }
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
    if (isHTMLInputElement(el) || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const inputType = isHTMLInputElement(el) ? (el.type || "text").toLowerCase() : "text";
      const autocomplete = el.getAttribute("autocomplete") || "";
      const nameIdPlaceholder = [
        (el instanceof HTMLElement && "name" in el && typeof el.name === "string" ? el.name : "") || el.getAttribute("name") || "",
        el.id || "",
        el.getAttribute("placeholder") || ""
      ].join(" ").toLowerCase();
      const keywordMatch = SENSITIVE_KEYWORDS.some((kw) => nameIdPlaceholder.includes(kw));
      const isSensitive = inputType === "password" || inputType === "hidden" || ["current-password", "new-password", "cc-number", "cc-csc"].includes(autocomplete) || keywordMatch;
      if (isSensitive) {
        node.value = "[REDACTED]";
        node.redacted = true;
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        node.value = el.value || "";
      }
      if (el instanceof HTMLInputElement) {
        node.checked = el.checked;
        node.disabled = el.disabled;
        node.readOnly = el.readOnly;
      }
    }
    if (isHTMLAnchorElement(el) && el.href) {
      node.href = el.href;
    }
    if (isHTMLImageElement(el) && el.src) {
      node.src = el.src;
    }
    if (isHTMLInputElement(el)) {
      node.inputType = el.type || "text";
    }
    if (children.length > 0) {
      node.children = children;
    }
    return node;
  }
  function buildInteractionTree() {
    nodeIdCounter = 0;
    nodeMap.clear();
    currentRevision++;
    const body = document.body;
    if (!body) {
      return {
        revision: currentRevision,
        url: window.location.href,
        title: document.title,
        root: { nodeId: "node_0", role: "generic", name: "", tag: "body", visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } },
        nodeCount: 0
      };
    }
    const root = buildNode(body, 0);
    return {
      revision: currentRevision,
      url: window.location.href,
      title: document.title,
      root: root ?? { nodeId: "node_0", role: "generic", name: "", tag: "body", visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, children: [] },
      nodeCount: nodeIdCounter
    };
  }
  function findByNodeId(value) {
    return nodeMap.get(value) ?? null;
  }
  function findByCss(value) {
    try {
      return document.querySelector(value);
    } catch {
      return null;
    }
  }
  function findByXpath(value) {
    const result = document.evaluate(
      value,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    const node = result.singleNodeValue;
    return node instanceof Element ? node : null;
  }
  function findByRole(roleSelector) {
    const all = document.querySelectorAll(`[role="${roleSelector.role}"]`);
    for (const el of all) {
      if (getRole(el) === roleSelector.role && getAccessibleName(el) === roleSelector.name) {
        return el;
      }
    }
    return null;
  }
  function findByText(value) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (el.textContent?.trim() === value && el.children.length === 0) return el;
    }
    return null;
  }
  function findByCoordinate(coord) {
    return document.elementFromPoint(coord.x, coord.y);
  }
  function findBySelector(sel) {
    if (!sel.type) return null;
    switch (sel.type) {
      case "nodeId":
        return typeof sel.value === "string" ? findByNodeId(sel.value) : null;
      case "css":
        return typeof sel.value === "string" ? findByCss(sel.value) : null;
      case "xpath":
        return typeof sel.value === "string" ? findByXpath(sel.value) : null;
      case "role":
        return sel.value && typeof sel.value === "object" && "role" in sel.value ? findByRole(sel.value) : null;
      case "text":
        return typeof sel.value === "string" ? findByText(sel.value) : null;
      case "coordinate":
        return sel.value && typeof sel.value === "object" && "x" in sel.value && "y" in sel.value ? findByCoordinate(sel.value) : null;
      default:
        return null;
    }
  }
  function findElement(selector, selectors, nodeId) {
    if (nodeId && nodeMap.has(nodeId)) {
      return nodeMap.get(nodeId) ?? null;
    }
    if (selectors && Array.isArray(selectors)) {
      for (const sel of selectors) {
        const el = findBySelector(sel);
        if (el) return el;
      }
    }
    if (selector) {
      return findBySelector(selector);
    }
    return null;
  }
  window.__BRP_ITREE__ = {
    buildInteractionTree,
    findElement,
    getRevision: () => currentRevision
  };
})();
