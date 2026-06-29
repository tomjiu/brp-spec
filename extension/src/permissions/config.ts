/**
 * E1 Permission Gating — Configuration & Storage
 *
 * Manages permission gate settings in browser.storage.local.
 * Default: all gates set to "ask" with predefined sensitive patterns.
 */

export type GateMode = "always" | "never" | "ask";

export interface PermissionGateConfig {
  permissionGates: {
    scriptExecute: GateMode;
    navigateSensitiveDomains: GateMode;
    clickSensitiveButtons: GateMode;
  };
  sensitiveDomains: string[];
  sensitiveButtonPatterns: string[];
  /** Internal flag for CI/testing — auto-approves all "ask" decisions */
  _autoApprovePermissions: boolean;
}

export const DEFAULT_CONFIG: PermissionGateConfig = {
  permissionGates: {
    scriptExecute: "ask",
    navigateSensitiveDomains: "ask",
    clickSensitiveButtons: "ask",
  },
  sensitiveDomains: [
    "*.bank.com",
    "*.paypal.com",
    "*.alipay.com",
    "*.tenpay.com",
  ],
  sensitiveButtonPatterns: [
    "submit order",
    "confirm payment",
    "delete",
    "确认支付",
    "提交订单",
    "删除",
  ],
  _autoApprovePermissions: false,
};

const STORAGE_KEY = "brpPermissionConfig";

/**
 * Load permission config from storage, falling back to defaults.
 */
export async function loadConfig(): Promise<PermissionGateConfig> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEY);
    if (result[STORAGE_KEY]) {
      // Merge with defaults to handle newly added keys
      return { ...DEFAULT_CONFIG, ...result[STORAGE_KEY] };
    }
  } catch {
    // storage.local unavailable (e.g. content script context)
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save permission config to storage.
 */
export async function saveConfig(config: PermissionGateConfig): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: config });
}

/**
 * Get current gate mode for a specific action type.
 */
export async function getGateMode(
  gateType: keyof PermissionGateConfig["permissionGates"],
): Promise<GateMode> {
  const config = await loadConfig();
  return config.permissionGates[gateType];
}
