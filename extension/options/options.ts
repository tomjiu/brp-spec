/**
 * BRP Extension Options Page
 *
 * Allows users to configure the auth token for Standalone mode.
 * Token is stored in browser.storage.local.
 */

/// <reference types="firefox-webext-browser" />

const tokenInput = document.getElementById("token-input") as HTMLInputElement;
const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement;
const generateBtn = document.getElementById("generate-btn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const lastUsedEl = document.getElementById("last-used") as HTMLParagraphElement;

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
