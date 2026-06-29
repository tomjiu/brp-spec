/**
 * E1 Permission Gating — Checker Logic
 *
 * Pure function module — determines whether an action should be
 * allowed, denied, or requires user confirmation.
 */

import type { PermissionGateConfig, GateMode } from "./config";

export type PermissionDecision = "allow" | "deny" | "ask";

/**
 * Check if a wildcard domain pattern matches a URL.
 * Supports "*" prefix wildcards, e.g. "*.bank.com" matches "login.bank.com".
 */
export function matchDomainPattern(pattern: string, url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const pat = pattern.toLowerCase().trim();

    // Exact match
    if (hostname === pat) return true;

    // Wildcard prefix: "*.bank.com" → matches "login.bank.com", "www.bank.com"
    if (pat.startsWith("*.")) {
      const suffix = pat.slice(1); // ".bank.com"
      return hostname.endsWith(suffix) || hostname === pat.slice(2);
    }
    // Suffix match without explicit wildcard
    if (pat.startsWith(".")) {
      return hostname.endsWith(pat);
    }
    return false;
  } catch {
    // Invalid URL — don't block
    return false;
  }
}

/**
 * Check if any pattern matches the given text (case-insensitive).
 */
function matchesAnyPattern(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

/**
 * Determine permission decision for a given method + params.
 */
export function shouldGate(
  method: string,
  params: Record<string, unknown>,
  config: PermissionGateConfig,
): PermissionDecision {
  // CI/testing bypass
  // ── script.execute ──
  if (method === "script.execute") {
    return gateToDecision(config.permissionGates.scriptExecute);
  }

  // ── page.navigate ──
  if (method === "page.navigate") {
    const url = (params.url || params.uri) as string | undefined;
    if (url && isSensitiveDomain(url, config.sensitiveDomains)) {
      return gateToDecision(config.permissionGates.navigateSensitiveDomains);
    }
    return "allow"; // non-sensitive URL, no gating needed
  }

  // ── element.click ──
  if (method === "element.click") {
    if (isSensitiveClick(params, config.sensitiveButtonPatterns)) {
      return gateToDecision(config.permissionGates.clickSensitiveButtons);
    }
    return "allow";
  }

  // All other methods — allowed by default
  return "allow";
}

function gateToDecision(gate: GateMode): PermissionDecision {
  switch (gate) {
    case "always": return "deny";
    case "never": return "allow";
    case "ask": return "ask";
  }
}

function isSensitiveDomain(url: string, domains: string[]): boolean {
  return domains.some((p) => matchDomainPattern(p, url));
}

function isSensitiveClick(
  params: Record<string, unknown>,
  patterns: string[],
): boolean {
  // NOTE: v0.5.0 only scans AI-provided selector.value, not actual button text.
  // False negatives possible if AI uses generic selector (e.g. "#submit-btn")
  // to click a sensitive button. v0.5.x will add button text inspection
  // (requires background to query element text before asking).
  // Check selector values
  const selector = params.selector as { type?: string; value?: unknown } | undefined;
  if (selector?.value && typeof selector.value === "string") {
    if (matchesAnyPattern(selector.value, patterns)) return true;
  }

  // Check multi-selectors
  const selectors = params.selectors as { type?: string; value?: unknown }[] | undefined;
  if (selectors) {
    for (const s of selectors) {
      if (s.value && typeof s.value === "string") {
        if (matchesAnyPattern(s.value, patterns)) return true;
      }
    }
  }

  return false;
}

// ─── E2 Domain Blacklist ───

/**
 * Check if a URL's domain matches any pattern in the blacklist.
 * Reuses matchDomainPattern for wildcard support (*.bank.com).
 */
export function isBlacklisted(url: string, blacklist: string[]): boolean {
  if (!url || blacklist.length === 0) return false;
  return blacklist.some((pattern) => matchDomainPattern(pattern, url));
}

/**
 * Extract the domain from a URL string.
 * Returns null for invalid URLs or non-http(s) schemes.
 */
export function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.toLowerCase();
    if (scheme !== "http:" && scheme !== "https:") return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}
