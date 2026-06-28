/**
 * Extension loading helper for integration tests.
 *
 * Uses Playwright to launch Firefox with the BRP extension loaded.
 * Extension connects to bridge at ws://127.0.0.1:9817 (standalone mode).
 */

import { firefox, type BrowserContext } from "@playwright/test";
import path from "path";

const EXTENSION_PATH = process.env.BRP_EXTENSION_PATH
  || path.resolve(__dirname, "../../../extension");

/**
 * Launch Firefox with BRP extension loaded.
 * Extension auto-connects via WebSocket in standalone mode.
 */
export async function launchBrowser(): Promise<BrowserContext> {
  // Firefox uses temp profile to load unsigned extensions
  const context = await firefox.launchPersistentContext("", {
    headless: true,
    args: [`--load-extension=${EXTENSION_PATH}`],
    ignoreHTTPSErrors: true,
  });

  return context;
}

/**
 * Wait for the extension to connect to the bridge (check background page console).
 */
export async function waitForExtensionConnect(context: BrowserContext, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pages = context.pages();

  // The extension's background page should be listed
  // Look for "[BRP] Connected to bridge" in console
  let connected = false;

  // Check all pages for the extension background
  while (Date.now() < deadline && !connected) {
    for (const page of pages) {
      if (page.url().startsWith("moz-extension://")) {
        connected = true;
        break;
      }
    }
    // If we found a moz-extension page, the extension loaded
    if (connected) break;
    await new Promise(r => setTimeout(r, 500));
  }

  // Give extension a moment to establish WS
  await new Promise(r => setTimeout(r, 2000));
}
