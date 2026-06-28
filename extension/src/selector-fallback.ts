/**
 * E4 Context Recovery Pipeline — Selector Fallback Chain
 *
 * When a selector fails to find an element, automatically retry via
 * fallback chain: nodeId → role → css → xpath → coordinate → text.
 *
 * Pure logic — no DOM globals. Imported by content.ts.
 */

import type { SelectorValue, SelectorType } from "./types.content";
import type { ITreeAPI } from "./types.content";

const FALLBACK_CHAIN: SelectorType[] = [
  "nodeId",
  "role",
  "css",
  "xpath",
  "coordinate",
  "text",
];

export interface FindResult {
  element: Element | null;
  matchedType?: SelectorType;
}

/**
 * Find an element by selector, with optional fallback chain retry.
 *
 * 1. Try main selector via ITree API.
 * 2. If not found and acceptFallback=true, try each type in
 *    FALLBACK_CHAIN (skipping the main selector type to avoid
 *    redundant retry).
 * 3. Return the element and the SelectorType that actually matched.
 */
export function findElementWithFallback(
  selector: SelectorValue | undefined,
  selectors: SelectorValue[] | undefined,
  nodeId: string | undefined,
  itree: ITreeAPI,
  acceptFallback: boolean,
): FindResult {
  // 1. Try main selector
  const el = itree.findElement(selector, selectors, nodeId);
  if (el) {
    return { element: el, ...(selector?.type ? { matchedType: selector.type } : {}) };
  }

  if (!acceptFallback || !selector) {
    return { element: null };
  }

  // 2. Fallback chain — skip main selector type
  for (const type of FALLBACK_CHAIN) {
    if (type === selector.type) continue;
    const fallbackSelector: SelectorValue = { ...selector, type };
    const fallbackEl = itree.findElement(fallbackSelector, undefined, nodeId);
    if (fallbackEl) {
      console.log(`[BRP E4] Selector fallback: ${selector.type} → ${type}`);
      return { element: fallbackEl, matchedType: type };
    }
  }

  return { element: null };
}
