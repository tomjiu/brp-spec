/**
 * E1 Permission Gating — Configuration & Storage
 *
 * Manages permission gate settings in browser.storage.local.
 * Default: all gates set to "ask" with predefined sensitive patterns.
 */

export type GateMode = "always" | "never" | "ask";

export type SensitiveFieldType =
  | "password"
  | "creditCard"
  | "cvv"
  | "email"
  | "ssn";

export interface ScreenshotBlurConfig {
  gate: GateMode;
  fieldTypes: SensitiveFieldType[];
  customSelectors: string[];
}

export interface PermissionGateConfig {
  permissionGates: {
    scriptExecute: GateMode;
    navigateSensitiveDomains: GateMode;
    clickSensitiveButtons: GateMode;
  };
  sensitiveDomains: string[];
  sensitiveButtonPatterns: string[];
  domainBlacklist: string[];
  domainAllowlist: string[];
  screenshotBlur: ScreenshotBlurConfig;
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
  domainBlacklist: [],
  domainAllowlist: [],
  screenshotBlur: {
    gate: "never",
    fieldTypes: ["password", "creditCard", "cvv"],
    customSelectors: [],
  },
};

const STORAGE_KEY = "brpPermissionConfig";

/**
 * Load permission config from storage, deep-merging with defaults
 * so newly added keys are always present.
 */
export async function loadConfig(): Promise<PermissionGateConfig> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY] as Partial<PermissionGateConfig> | undefined;
    if (stored) {
      return {
        ...DEFAULT_CONFIG,
        ...stored,
        permissionGates: {
          ...DEFAULT_CONFIG.permissionGates,
          ...(stored.permissionGates ?? {}),
        },
        screenshotBlur: {
          ...DEFAULT_CONFIG.screenshotBlur,
          ...(stored.screenshotBlur ?? {}),
        },
      };
    }
  } catch { /* storage.local unavailable (e.g. content script context) */ }
  return { ...DEFAULT_CONFIG };
}

/** Save permission config to storage. */
export async function saveConfig(config: PermissionGateConfig): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: config });
}

/** Get current gate mode for a specific action type. */
export async function getGateMode(
  gateType: keyof PermissionGateConfig["permissionGates"],
): Promise<GateMode> {
  const config = await loadConfig();
  return config.permissionGates[gateType];
}
