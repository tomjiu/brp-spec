/**
 * v0.8.0 — E2E Firefox Launcher
 *
 * Launches Firefox with the BRP extension loaded using Playwright's
 * native Firefox launch + --load-extension flag. More reliable than
 * web-ext in CI/xvfb environments.
 */

import { firefox, type Browser } from "@playwright/test";
import path from "path";

const EXTENSION_PATH = path.resolve(__dirname, "../../../extension");

export class E2EFirefox {
  private browser: Browser | null = null;
  private ready = false;

  /** Start Firefox with the extension loaded. */
  async start(): Promise<void> {
    this.browser = await firefox.launch({
      headless: false, // xvfb provides virtual display in CI
      args: [`--load-extension=${EXTENSION_PATH}`],
    });

    // Wait for extension background script to start + connect to bridge
    // Bridge WS is on 127.0.0.1:9817, extension auto-connects
    await new Promise((r) => setTimeout(r, 3000));

    this.ready = true;
    console.log("[e2e-firefox] Firefox launched with extension");
  }

  isReady(): boolean {
    return this.ready;
  }

  getBrowser(): Browser | null {
    return this.browser;
  }

  stop(): void {
    if (this.browser) {
      console.log("[e2e-firefox] Shutting down Firefox");
      this.browser.close();
      this.browser = null;
      this.ready = false;
    }
  }
}
