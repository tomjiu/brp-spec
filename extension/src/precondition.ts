/**
 * E3 DOM Precondition Validation
 *
 * Pure logic — no DOM globals. Exported for testing.
 * Imported by content.ts for action handler integration.
 */

import type { ContentError, Precondition } from "./types.content";

function preconditionFailed(el: Element, reason: string): ContentError {
  const actual: Record<string, unknown> = {
    tagName: el.tagName.toLowerCase(),
    textContent: el.textContent?.trim().slice(0, 200) ?? "",
  };
  const attrs: Record<string, string> = {};
  for (const name of el.getAttributeNames()) {
    const val = el.getAttribute(name);
    if (val !== null) attrs[name] = val;
  }
  actual.attributes = attrs;
  return {
    error: `Precondition failed: ${reason}`,
    errorCode: "BRP_PRECONDITION_FAILED",
    retriable: false,
    recoveryHint: JSON.stringify(actual),
  };
}

export function validatePrecondition(
  el: Element,
  pre?: Precondition,
): ContentError | null {
  if (!pre) return null;
  if (pre.tagName && el.tagName.toUpperCase() !== pre.tagName.toUpperCase()) {
    return preconditionFailed(
      el,
      `expected tagName "${pre.tagName}", got "${el.tagName}"`,
    );
  }
  if (pre.textContains && !(el.textContent ?? "").includes(pre.textContains)) {
    return preconditionFailed(
      el,
      `expected textContains "${pre.textContains}"`,
    );
  }
  if (pre.attributes) {
    for (const [k, v] of Object.entries(pre.attributes)) {
      if (el.getAttribute(k) !== v) {
        return preconditionFailed(
          el,
          `expected attribute ${k}="${v}", got "${el.getAttribute(k)}"`,
        );
      }
    }
  }
  return null;
}
