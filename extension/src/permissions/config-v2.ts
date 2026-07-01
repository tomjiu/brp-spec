/**
 * v0.9.0 Permission Model v2 — Resource permission defaults.
 *
 * Each resource maps to a default policy per action:
 *   "always" — grant without prompt
 *   "ask"    — show permission dialog
 *   "deny"   — deny by default (must be explicitly enabled)
 */

export type PermissionPolicy = "always" | "ask" | "deny";

export interface ResourcePermission {
  read: PermissionPolicy;
  write: PermissionPolicy;
  delete: PermissionPolicy;
}

export interface PermissionConfig {
  cookie: ResourcePermission;
  tab: { close: PermissionPolicy };
  script: { execute: PermissionPolicy };
  clipboard: ResourcePermission;
  downloads: ResourcePermission;
}

/** Default permission policy — conservative, backs E1/E2 existing behavior. */
export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  cookie:       { read: "deny",  write: "deny",  delete: "deny" },
  tab:          { close: "ask" },
  script:       { execute: "ask" },
  clipboard:    { read: "deny",  write: "deny",  delete: "deny" },
  downloads:    { read: "deny",  write: "deny",  delete: "deny" },
};

/**
 * Map a BRP method to (resource, action) for permission lookup.
 * Returns null for methods that don't require permission.
 */
export function methodResourceAction(method: string): { resource: string; action: string } | null {
  if (method.startsWith("cookie.")) {
    if (method.includes(".delete") || method.includes(".clear")) return { resource: "cookie", action: "delete" };
    if (method.includes(".set") || method.includes(".create"))   return { resource: "cookie", action: "write" };
    return { resource: "cookie", action: "read" };
  }
  if (method === "tab.close") return { resource: "tab", action: "close" };
  if (method === "script.execute") return { resource: "script", action: "execute" };
  if (method.startsWith("clipboard.")) {
    if (method.includes(".read") || method.includes(".get"))      return { resource: "clipboard", action: "read" };
    if (method.includes(".delete") || method.includes(".remove")) return { resource: "clipboard", action: "delete" };
    return { resource: "clipboard", action: "write" };
  }
  if (method.startsWith("downloads.")) {
    if (method.includes(".read") || method.includes(".get"))      return { resource: "downloads", action: "read" };
    if (method.includes(".delete") || method.includes(".remove")) return { resource: "downloads", action: "delete" };
    return { resource: "downloads", action: "write" };
  }
  return null;
}
