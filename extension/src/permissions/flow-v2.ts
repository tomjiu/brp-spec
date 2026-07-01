/**
 * v0.9.0 Permission Model v2 — query, request, revoke.
 *
 * Uses browser.storage.local for persistence.
 */

import { PermissionPolicy, DEFAULT_PERMISSION_CONFIG, methodResourceAction } from "./config-v2";

const STORAGE_KEY = "brpPermissionOverrides";

interface PermissionOverrides {
  [resource: string]: {
    read?: PermissionPolicy;
    write?: PermissionPolicy;
    delete?: PermissionPolicy;
    close?: PermissionPolicy;
    execute?: PermissionPolicy;
  };
}

async function loadOverrides(): Promise<PermissionOverrides> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEY);
    return (result[STORAGE_KEY] as PermissionOverrides) ?? {};
  } catch {
    return {};
  }
}

async function saveOverrides(overrides: PermissionOverrides): Promise<void> {
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: overrides });
  } catch {
    // storage may be unavailable — fail silently
  }
}

export async function lookupPolicy(
  method: string,
): Promise<{ resource: string; action: string; policy: PermissionPolicy } | null> {
  const mapping = methodResourceAction(method);
  if (!mapping) return null;

  const overrides = await loadOverrides();
  const override = overrides[mapping.resource]?.[mapping.action as keyof typeof overrides[string]];

  if (override) {
    return { ...mapping, policy: override };
  }

  const config = DEFAULT_PERMISSION_CONFIG[mapping.resource as keyof typeof DEFAULT_PERMISSION_CONFIG] as Record<string, PermissionPolicy> | undefined;
  const defaultPolicy: PermissionPolicy = config?.[mapping.action] ?? "deny";

  return { ...mapping, policy: defaultPolicy };
}

export async function isPermitted(method: string): Promise<boolean> {
  const result = await lookupPolicy(method);
  if (!result) return true; // no permission required
  return result.policy === "always";
}

export async function requestPermission(
  resource: string,
  action: string,
): Promise<{ granted: boolean; policy: PermissionPolicy }> {
  const config = DEFAULT_PERMISSION_CONFIG[resource as keyof typeof DEFAULT_PERMISSION_CONFIG] as Record<string, PermissionPolicy> | undefined;
  const policy: PermissionPolicy = config?.[action] ?? "deny";

  if (policy === "deny") return { granted: false, policy: "deny" };
  if (policy === "always") return { granted: true, policy: "always" };

  // "ask" — show dialog, persist on grant
  const granted = confirm(`BRP wants to ${action} your ${resource}\n\nAllow this action?`);
  if (granted) {
    const overrides = await loadOverrides();
    const res = overrides[resource] ?? {};
    (res as Record<string, PermissionPolicy>)[action] = "always";
    overrides[resource] = res;
    await saveOverrides(overrides);
    return { granted: true, policy: "always" };
  }

  return { granted: false, policy: "ask" };
}

export async function revokePermission(resource: string, action: string): Promise<void> {
  const overrides = await loadOverrides();
  const res = overrides[resource];
  if (res) {
    delete (res as Record<string, PermissionPolicy>)[action];
    if (Object.keys(res).length === 0) {
      delete overrides[resource];
    }
    await saveOverrides(overrides);
  }
}
