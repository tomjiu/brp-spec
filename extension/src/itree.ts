/**
 * BRP Interaction Tree Builder
 *
 * Walks the DOM and produces a structured Interaction Tree (ITree)
 * that the AI client can reason about.
 */

import type {
  ITreeAPI,
  ITreeResult,
  ITreeNode,
  SelectorValue,
  RoleSelectorValue,
  CoordinateSelectorValue,
} from "./types.content";
import { isHTMLElement, isHTMLInputElement, isHTMLAnchorElement, isHTMLImageElement } from "./types.content";

declare global {
  interface Window {
    __BRP_ITREE__: ITreeAPI;
  }
}

let currentRevision = 0;
let nodeIdCounter = 0;
const nodeMap = new Map<string, Element>(); // nodeId -> element

// ─── Role Mapping ───

const ROLE_MAP: Record<string, string> = {
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

const INPUT_TYPE_ROLE: Record<string, string | null> = {
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

const SENSITIVE_KEYWORDS = [
  "password", "passwd", "secret", "cvv", "csc", "ccv",
  "ssn", "otp", "pin", "creditcard", "credit-card", "cc-number",
  "cardnumber", "securitycode", "verification",
] as const;

// ─── DOM Helpers ───

function isInteractive(el: Element): boolean {
  const tag = el.tagName;
  const style = window.getComputedStyle(el);

  // Skip hidden elements
  if (style.display === "none" || style.visibility === "hidden") return false;

  // Always include interactive elements
  if (tag in ROLE_MAP) return true;
  if (el.getAttribute("role")) return true;
  // onclick could be a string or null; check both
  const elAny = el as unknown as Record<string, unknown>;
  const clickHandler = elAny.onclick;
  if (clickHandler !== null && clickHandler !== undefined) return true;
  if (el.getAttribute("onclick")) return true;
  if (el instanceof HTMLElement && el.tabIndex >= 0) return true;
  if (el instanceof HTMLElement && el.contentEditable === "true") return true;

  // Include elements with text content that might be clickable
  if (el.children.length === 0 && el.textContent?.trim()) return true;

  return false;
}

function getAccessibleName(el: Element): string {
  // aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  // aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/);
    const texts = ids
      .map((id: string) => {
        const labelEl = document.getElementById(id);
        return labelEl ? labelEl.textContent?.trim() ?? "" : "";
      })
      .filter(Boolean);
    if (texts.length) return texts.join(" ");
  }

  // title attribute
  const title = el.getAttribute("title");
  if (title) return title;

  // For inputs, check associated label
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label instanceof HTMLElement && label.textContent) {
      return label.textContent.trim();
    }
  }

  // Placeholder for text inputs
  if (isHTMLInputElement(el) && el.placeholder) return el.placeholder;

  // alt for images
  if (isHTMLImageElement(el) && el.alt) return el.alt;

  // Text content (trimmed)
  const text = el.textContent?.trim();
  if (text && text.length < 200) return text;

  return "";
}

function getRole(el: Element): string {
  // Explicit ARIA role
  const ariaRole = el.getAttribute("role");
  if (ariaRole) return ariaRole;

  const tag = el.tagName;

  // Special handling for inputs
  if (tag === "INPUT" && isHTMLInputElement(el)) {
    const type = (el.type || "text").toLowerCase();
    return INPUT_TYPE_ROLE[type] ?? "textbox";
  }

  return ROLE_MAP[tag] ?? "generic";
}

// ─── Tree Builder ───

function buildNode(el: Element, depth: number): ITreeNode | null {
  if (depth > 64) return null; // guard against deeply nested DOM

  const interactive = isInteractive(el);

  // Build children first — always recurse regardless of parent interactivity
  const children: ITreeNode[] = [];
  for (const child of el.children) {
    const childNode = buildNode(child, depth + 1);
    if (childNode) children.push(childNode);
  }

  // Non-interactive element: return children directly (no wrapper node)
  if (!interactive) {
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    // Multiple children: wrap in a generic container
    return {
      nodeId: `node_${++nodeIdCounter}`,
      role: "generic",
      name: "",
      tag: el.tagName.toLowerCase(),
      visible: true,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      children,
    };
  }

  const nodeId = `node_${++nodeIdCounter}`;
  nodeMap.set(nodeId, el);

  const rect = el.getBoundingClientRect();
  const role = getRole(el);
  const name = getAccessibleName(el);

  const node: ITreeNode = {
    nodeId,
    role,
    name,
    tag: el.tagName.toLowerCase(),
    visible: rect.width > 0 && rect.height > 0,
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };

  // Add value for inputs (with sensitive field redaction)
  if (isHTMLInputElement(el) || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
    const inputType = isHTMLInputElement(el) ? (el.type || "text").toLowerCase() : "text";
    const autocomplete = el.getAttribute("autocomplete") || "";

    const nameIdPlaceholder = [
      (el instanceof HTMLElement && "name" in el && typeof el.name === "string" ? el.name : "") ||
        el.getAttribute("name") || "",
      el.id || "",
      el.getAttribute("placeholder") || "",
    ]
      .join(" ")
      .toLowerCase();

    const keywordMatch = SENSITIVE_KEYWORDS.some((kw: string) => nameIdPlaceholder.includes(kw));

    const isSensitive =
      inputType === "password" ||
      inputType === "hidden" ||
      ["current-password", "new-password", "cc-number", "cc-csc"].includes(autocomplete) ||
      keywordMatch;

    if (isSensitive) {
      node.value = "[REDACTED]";
      node.redacted = true;
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      node.value = (el as HTMLInputElement).value || "";
    }

    if (el instanceof HTMLInputElement) {
      node.checked = el.checked;
      node.disabled = el.disabled;
      node.readOnly = el.readOnly;
    }
  }

  // Add href for links
  if (isHTMLAnchorElement(el) && el.href) {
    node.href = el.href;
  }

  // Add src for images
  if (isHTMLImageElement(el) && el.src) {
    node.src = el.src;
  }

  // Add type for inputs
  if (isHTMLInputElement(el)) {
    node.inputType = el.type || "text";
  }

  // Attach already-built children
  if (children.length > 0) {
    node.children = children;
  }

  return node;
}

// ─── Public API ───

function buildInteractionTree(): ITreeResult {
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
      nodeCount: 0,
    };
  }

  const root = buildNode(body, 0);

  return {
    revision: currentRevision,
    url: window.location.href,
    title: document.title,
    root: root ?? { nodeId: "node_0", role: "generic", name: "", tag: "body", visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, children: [] },
    nodeCount: nodeIdCounter,
  };
}

// ─── Selector Resolution ───

function findByNodeId(value: string): Element | null {
  return nodeMap.get(value) ?? null;
}

function findByCss(value: string): Element | null {
  try {
    return document.querySelector(value);
  } catch {
    return null;
  }
}

function findByXpath(value: string): Element | null {
  const result = document.evaluate(
    value,
    document,
    null,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
    null,
  );
  const node = result.singleNodeValue;
  return node instanceof Element ? node : null;
}

function findByRole(roleSelector: RoleSelectorValue): Element | null {
  const all = document.querySelectorAll(`[role="${roleSelector.role}"]`);
  for (const el of all) {
    if (getRole(el) === roleSelector.role && getAccessibleName(el) === roleSelector.name) {
      return el;
    }
  }
  return null;
}

function findByText(value: string): Element | null {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const el = walker.currentNode as Element;
    if (el.textContent?.trim() === value && el.children.length === 0) return el;
  }
  return null;
}

function findByCoordinate(coord: CoordinateSelectorValue): Element | null {
  return document.elementFromPoint(coord.x, coord.y);
}

function findBySelector(sel: SelectorValue): Element | null {
  if (!sel.type) return null;

  switch (sel.type) {
    case "nodeId":
      return typeof sel.value === "string" ? findByNodeId(sel.value) : null;

    case "css":
      return typeof sel.value === "string" ? findByCss(sel.value) : null;

    case "xpath":
      return typeof sel.value === "string" ? findByXpath(sel.value) : null;

    case "role":
      return sel.value && typeof sel.value === "object" && "role" in sel.value
        ? findByRole(sel.value as RoleSelectorValue)
        : null;

    case "text":
      return typeof sel.value === "string" ? findByText(sel.value) : null;

    case "coordinate":
      return sel.value && typeof sel.value === "object" && "x" in sel.value && "y" in sel.value
        ? findByCoordinate(sel.value as CoordinateSelectorValue)
        : null;

    default:
      return null;
  }
}

function findElement(
  selector?: SelectorValue,
  selectors?: SelectorValue[],
  nodeId?: string,
): Element | null {
  // By nodeId
  if (nodeId && nodeMap.has(nodeId)) {
    return nodeMap.get(nodeId) ?? null;
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

// ─── Expose to content.ts ───

window.__BRP_ITREE__ = {
  buildInteractionTree,
  findElement,
  getRevision: (): number => currentRevision,
};
