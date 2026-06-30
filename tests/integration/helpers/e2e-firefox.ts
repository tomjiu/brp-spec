/**
 * v0.7.0 — E2E Firefox Launcher
 *
 * Launches Firefox with the BRP extension loaded using web-ext.
 * Provides Playwright browser/page access for DOM verification.
 *
 * Note: Firefox headless + extension loading has platform-specific quirks.
 * Local testing recommended before CI deployment.
 */

import { spawn, type ChildProcess } from "child_process";
import path from "path";

const EXTENSION_PATH = path.resolve(__dirname, "../../../extension");
const FIREFOX_START_TIMEOUT = 30000;

export class E2EFirefox {
  private firefoxProc: ChildProcess | null = null;
  private ready = false;

  /** Start Firefox with the extension loaded via web-ext. */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // web-ext run --firefox --source-dir extension/ --no-input --keep-profile-changes
      const args = [
        "web-ext", "run",
        "--firefox",
        "--source-dir", EXTENSION_PATH,
        "--no-input",
        "--keep-profile-changes",
        "--verbose",
        "--firefox-profile", "default",
      ];

      console.log(`[e2e-firefox] Starting: npx ${args.join(" ")}`);

      this.firefoxProc = spawn("npx", args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      });

      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        reject(new Error(`Firefox start timeout (${FIREFOX_START_TIMEOUT}ms)`));
      }, FIREFOX_START_TIMEOUT);

      this.firefoxProc.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
        if (stdout.includes("Firefox is running") || stdout.includes("Extension loaded")) {
          this.ready = true;
          clearTimeout(timer);
          console.log("[e2e-firefox] Firefox launched with extension");
          // Give Firefox + extension a moment to initialize
          setTimeout(() => resolve(), 2000);
        }
      });

      this.firefoxProc.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
        // web-ext may log to stderr
        if (stderr.includes("Firefox is running")) {
          this.ready = true;
          clearTimeout(timer);
          setTimeout(() => resolve(), 2000);
        }
      });

      this.firefoxProc.on("error", (err: Error) => {
        clearTimeout(timer);
        console.error(`[e2e-firefox] spawn error: ${err.message}`);
        reject(err);
      });

      this.firefoxProc.on("exit", (code: number | null) => {
        if (!this.ready) {
          clearTimeout(timer);
          reject(new Error(`Firefox exited early with code ${code}`));
        }
      });
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  stop(): void {
    if (this.firefoxProc) {
      console.log("[e2e-firefox] Shutting down Firefox");
      this.firefoxProc.kill("SIGTERM");
      this.firefoxProc = null;
      this.ready = false;
    }
  }
}
