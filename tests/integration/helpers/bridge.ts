/**
 * Bridge process lifecycle helper for integration tests.
 *
 * Starts bridge in standalone mode (fixed port 9817) for reliable testing.
 * B1 auto-link (connectNative) testing deferred — headless Firefox native
 * messaging compatibility unknown.
 */

import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

const BRIDGE_BINARY = (() => {
  if (process.env.BRP_BRIDGE_PATH) return process.env.BRP_BRIDGE_PATH;
  const base = path.resolve(__dirname, "../../../bridge/target/release");
  // On Windows, append .exe
  if (process.platform === "win32") return path.join(base, "brp-bridge.exe");
  return path.join(base, "brp-bridge");
})();

const BRIDGE_PORT = 9817;
const BRIDGE_TOKEN = process.env.BRP_AUTH_TOKEN || "integration-test-token";

export interface BridgeInfo {
  port: number;
  token: string;
  process: ChildProcess;
}

/**
 * Start bridge in standalone mode with fixed port.
 * Throws if binary not found or bridge fails to start.
 */
export function startBridge(): BridgeInfo {
  if (!fs.existsSync(BRIDGE_BINARY)) {
    throw new Error(`Bridge binary not found: ${BRIDGE_BINARY}`);
  }

  const proc = spawn(BRIDGE_BINARY, ["--mode=bridge"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      BRP_WS_ADDR: `127.0.0.1:${BRIDGE_PORT}`,
      BRP_AUTH_TOKEN: BRIDGE_TOKEN,
      BRP_STANDALONE: "1",
    },
  });

  proc.on("error", (err: Error) => {
    console.error(`[bridge] spawn error: ${err.message}`);
  });

  return { port: BRIDGE_PORT, token: BRIDGE_TOKEN, process: proc };
}

export function stopBridge(info: BridgeInfo): void {
  info.process.kill("SIGTERM");
}
