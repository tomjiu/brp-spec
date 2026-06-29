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

// Domain blacklist elements
const blacklistEl = document.getElementById("blacklist-domains") as HTMLTextAreaElement;
const blacklistSaveBtn = document.getElementById("blacklist-save-btn") as HTMLButtonElement;
const blacklistClearBtn = document.getElementById("blacklist-clear-btn") as HTMLButtonElement;
const blacklistStatusEl = document.getElementById("blacklist-status") as HTMLDivElement;

// Domain allowlist elements
const allowlistEl = document.getElementById("allowlist-domains") as HTMLTextAreaElement;
const allowlistSaveBtn = document.getElementById("allowlist-save-btn") as HTMLButtonElement;
const allowlistClearBtn = document.getElementById("allowlist-clear-btn") as HTMLButtonElement;
const allowlistStatusEl = document.getElementById("allowlist-status") as HTMLDivElement;

// Screenshot blur elements
const blurGate = document.getElementById("blur-gate") as HTMLSelectElement;
const blurPassword = document.getElementById("blur-password") as HTMLInputElement;
const blurCredit = document.getElementById("blur-credit") as HTMLInputElement;
const blurCvv = document.getElementById("blur-cvv") as HTMLInputElement;
const blurEmail = document.getElementById("blur-email") as HTMLInputElement;
const blurSsn = document.getElementById("blur-ssn") as HTMLInputElement;
const blurCustom = document.getElementById("blur-custom") as HTMLTextAreaElement;
const blurSaveBtn = document.getElementById("blur-save-btn") as HTMLButtonElement;
const blurResetBtn = document.getElementById("blur-reset-btn") as HTMLButtonElement;
const blurStatusEl = document.getElementById("blur-status") as HTMLDivElement;

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
const DEFAULT_BLUR: { gate: string; fieldTypes: string[] } = {
  gate: "never",
  fieldTypes: ["password", "creditCard", "cvv"],
};

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
      blacklistEl.value = (config.domainBlacklist || []).join("\n");
      allowlistEl.value = (config.domainAllowlist || []).join("\n");
      // Load screenshot blur
      const sb = config.screenshotBlur;
      if (sb) {
        blurGate.value = sb.gate || "never";
        const types = sb.fieldTypes || [];
        blurPassword.checked = types.includes("password");
        blurCredit.checked = types.includes("creditCard");
        blurCvv.checked = types.includes("cvv");
        blurEmail.checked = types.includes("email");
        blurSsn.checked = types.includes("ssn");
        blurCustom.value = (sb.customSelectors || []).join("\n");
      }
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
      domainBlacklist: blacklistEl.value
        .split("\n")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0),
      domainAllowlist: allowlistEl.value
        .split("\n")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0),
      screenshotBlur: {
        gate: blurGate.value,
        fieldTypes: buildBlurFieldTypes(),
        customSelectors: blurCustom.value
          .split("\n").map((s: string) => s.trim()).filter((s: string) => s.length > 0),
      },
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

// ─── Domain Blacklist Handlers ───

blacklistSaveBtn.addEventListener("click", async () => {
  try {
    const result = await browser.storage.local.get("brpPermissionConfig");
    const config = result.brpPermissionConfig || {};
    const patterns = blacklistEl.value
      .split("\n")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);
    await browser.storage.local.set({
      brpPermissionConfig: { ...config, domainBlacklist: patterns },
    });
    blacklistStatusEl.textContent = "Blacklist saved.";
    blacklistStatusEl.className = "status success";
    setTimeout(() => { blacklistStatusEl.className = "status"; }, 3000);
  } catch (e: unknown) {
    blacklistStatusEl.textContent = "Failed: " + (e instanceof Error ? e.message : String(e));
    blacklistStatusEl.className = "status error";
    setTimeout(() => { blacklistStatusEl.className = "status"; }, 3000);
  }
});

blacklistClearBtn.addEventListener("click", () => {
  blacklistEl.value = "";
});

// ─── Screenshot Blur Handlers ───

function buildBlurFieldTypes(): string[] {
  const types: string[] = [];
  if (blurPassword.checked) types.push("password");
  if (blurCredit.checked) types.push("creditCard");
  if (blurCvv.checked) types.push("cvv");
  if (blurEmail.checked) types.push("email");
  if (blurSsn.checked) types.push("ssn");
  return types;
}

blurSaveBtn.addEventListener("click", async () => {
  try {
    const result = await browser.storage.local.get("brpPermissionConfig");
    const config = result.brpPermissionConfig || {};
    await browser.storage.local.set({
      brpPermissionConfig: {
        ...config,
        screenshotBlur: {
          gate: blurGate.value,
          fieldTypes: buildBlurFieldTypes(),
          customSelectors: blurCustom.value
            .split("\n").map((s: string) => s.trim()).filter((s: string) => s.length > 0),
        },
      },
    });
    blurStatusEl.textContent = "Screenshot blur settings saved.";
    blurStatusEl.className = "status success";
    setTimeout(() => { blurStatusEl.className = "status"; }, 3000);
  } catch (e: unknown) {
    blurStatusEl.textContent = "Failed: " + (e instanceof Error ? e.message : String(e));
    blurStatusEl.className = "status error";
    setTimeout(() => { blurStatusEl.className = "status"; }, 3000);
  }
});

blurResetBtn.addEventListener("click", () => {
  blurGate.value = DEFAULT_BLUR.gate;
  blurPassword.checked = DEFAULT_BLUR.fieldTypes.includes("password");
  blurCredit.checked = DEFAULT_BLUR.fieldTypes.includes("creditCard");
  blurCvv.checked = DEFAULT_BLUR.fieldTypes.includes("cvv");
  blurEmail.checked = false;
  blurSsn.checked = false;
  blurCustom.value = "";
});

// ─── Domain Allowlist Handlers ───

allowlistSaveBtn.addEventListener("click", async () => {
  try {
    const result = await browser.storage.local.get("brpPermissionConfig");
    const config = result.brpPermissionConfig || {};
    const patterns = allowlistEl.value
      .split("\n")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);
    await browser.storage.local.set({
      brpPermissionConfig: { ...config, domainAllowlist: patterns },
    });
    allowlistStatusEl.textContent = "Allowlist saved.";
    allowlistStatusEl.className = "status success";
    setTimeout(() => { allowlistStatusEl.className = "status"; }, 3000);
  } catch (e: unknown) {
    allowlistStatusEl.textContent = "Failed: " + (e instanceof Error ? e.message : String(e));
    allowlistStatusEl.className = "status error";
    setTimeout(() => { allowlistStatusEl.className = "status"; }, 3000);
  }
});

allowlistClearBtn.addEventListener("click", () => {
  allowlistEl.value = "";
});
