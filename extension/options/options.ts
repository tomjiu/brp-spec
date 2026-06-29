/**
 * BRP Extension Options Page
 *
 * Allows users to configure the auth token and permission gates.
 * All data stored in browser.storage.local.
 */

/// <reference types="firefox-webext-browser" />

const tokenInput = document.getElementById("token-input") as HTMLInputElement;
const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement;
const generateBtn = document.getElementById("generate-btn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const lastUsedEl = document.getElementById("last-used") as HTMLParagraphElement;

// Permission gate elements
const gateScript = document.getElementById("gate-script") as HTMLSelectElement;
const gateNavigate = document.getElementById("gate-navigate") as HTMLSelectElement;
const gateClick = document.getElementById("gate-click") as HTMLSelectElement;
const sensitiveDomainsEl = document.getElementById("sensitive-domains") as HTMLTextAreaElement;
const sensitiveButtonsEl = document.getElementById("sensitive-buttons") as HTMLTextAreaElement;
const permSaveBtn = document.getElementById("perm-save-btn") as HTMLButtonElement;
const permResetBtn = document.getElementById("perm-reset-btn") as HTMLButtonElement;
const permStatusEl = document.getElementById("perm-status") as HTMLDivElement;

const DEFAULT_GATES = {
  scriptExecute: "ask",
  navigateSensitiveDomains: "ask",
  clickSensitiveButtons: "ask",
};
const DEFAULT_DOMAINS = [
  "*.bank.com", "*.paypal.com", "*.alipay.com", "*.tenpay.com",
];
const DEFAULT_BUTTONS = [
  "submit order", "confirm payment", "delete",
  "确认支付", "提交订单", "删除",
];

function showStatus(message: string, type: "success" | "error" = "success"): void {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  setTimeout(() => {
    statusEl.className = "status";
  }, 3000);
}

async function loadToken(): Promise<void> {
  try {
    const result = await browser.storage.local.get(["brpAuthToken", "brpTokenLastUsed"]);
    const token = result.brpAuthToken;
    if (typeof token === "string" && token) {
      tokenInput.value = token;
    }
    const lastUsed = result.brpTokenLastUsed;
    if (typeof lastUsed === "string") {
      const date = new Date(lastUsed);
      lastUsedEl.textContent = `Last used: ${date.toLocaleString()}`;
    } else {
      lastUsedEl.textContent = "Token has not been used yet.";
    }
  } catch (e: unknown) {
    console.error("Failed to load token:", e instanceof Error ? e.message : String(e));
  }
}

saveBtn.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  try {
    await browser.storage.local.set({
      brpAuthToken: token,
      brpTokenLastUsed: new Date().toISOString(),
    });
    showStatus(token ? "Token saved successfully." : "Token cleared.");
  } catch (e: unknown) {
    showStatus("Failed to save token: " + (e instanceof Error ? e.message : String(e)), "error");
  }
});

clearBtn.addEventListener("click", async () => {
  tokenInput.value = "";
  try {
    await browser.storage.local.remove(["brpAuthToken", "brpTokenLastUsed"]);
    showStatus("Token cleared.");
    lastUsedEl.textContent = "Token has not been used yet.";
  } catch (e: unknown) {
    showStatus("Failed to clear token: " + (e instanceof Error ? e.message : String(e)), "error");
  }
});

generateBtn.addEventListener("click", () => {
  // Generate a random UUID v4-like token
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const token = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");

  tokenInput.value = token;
  showStatus("New token generated. Click 'Save Token' to store it.");
});

// Load on page open
void loadToken();
void loadPermissionGates();

// ─── Permission Gate Logic ───

async function loadPermissionGates(): Promise<void> {
  try {
    const result = await browser.storage.local.get("brpPermissionConfig");
    const config = result.brpPermissionConfig;
    if (config?.permissionGates) {
      gateScript.value = config.permissionGates.scriptExecute || "ask";
      gateNavigate.value = config.permissionGates.navigateSensitiveDomains || "ask";
      gateClick.value = config.permissionGates.clickSensitiveButtons || "ask";
      sensitiveDomainsEl.value = (config.sensitiveDomains || DEFAULT_DOMAINS).join("\n");
      sensitiveButtonsEl.value = (config.sensitiveButtonPatterns || DEFAULT_BUTTONS).join("\n");
    } else {
      resetPermissionGates();
    }
  } catch (e: unknown) {
    console.error("Failed to load permission config:", e);
  }
}

function resetPermissionGates(): void {
  gateScript.value = DEFAULT_GATES.scriptExecute;
  gateNavigate.value = DEFAULT_GATES.navigateSensitiveDomains;
  gateClick.value = DEFAULT_GATES.clickSensitiveButtons;
  sensitiveDomainsEl.value = DEFAULT_DOMAINS.join("\n");
  sensitiveButtonsEl.value = DEFAULT_BUTTONS.join("\n");
}

permSaveBtn.addEventListener("click", async () => {
  try {
    const config = {
      permissionGates: {
        scriptExecute: gateScript.value,
        navigateSensitiveDomains: gateNavigate.value,
        clickSensitiveButtons: gateClick.value,
      },
      sensitiveDomains: sensitiveDomainsEl.value
        .split("\n")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0),
      sensitiveButtonPatterns: sensitiveButtonsEl.value
        .split("\n")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0),
      _autoApprovePermissions: false,
    };
    await browser.storage.local.set({ brpPermissionConfig: config });
    permStatusEl.textContent = "Permission gates saved.";
    permStatusEl.className = "status success";
    setTimeout(() => { permStatusEl.className = "status"; }, 3000);
  } catch (e: unknown) {
    permStatusEl.textContent = "Failed to save: " + (e instanceof Error ? e.message : String(e));
    permStatusEl.className = "status error";
    setTimeout(() => { permStatusEl.className = "status"; }, 3000);
  }
});

permResetBtn.addEventListener("click", async () => {
  resetPermissionGates();
  try {
    await browser.storage.local.remove("brpPermissionConfig");
    permStatusEl.textContent = "Reset to defaults.";
    permStatusEl.className = "status success";
    setTimeout(() => { permStatusEl.className = "status"; }, 3000);
  } catch (e: unknown) {
    permStatusEl.textContent = "Failed to reset: " + (e instanceof Error ? e.message : String(e));
    permStatusEl.className = "status error";
    setTimeout(() => { permStatusEl.className = "status"; }, 3000);
  }
});
