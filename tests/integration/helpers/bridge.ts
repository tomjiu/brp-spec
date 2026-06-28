/**
 * Bridge process lifecycle helper for integration tests.
 *
 * Starts bridge in standalone mode (fixed port 9817), waits for it to
 * actually listen before resolving. Returns BridgeInfo.
 */

import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import net from "net";

const BRIDGE_BINARY = (() => {
  if (process.env.BRP_BRIDGE_PATH) return process.env.BRP_BRIDGE_PATH;
  const base = path.resolve(__dirname, "../../../bridge/target/release");
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

function checkPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.on("connect", () => { sock.destroy(); resolve(); });
    sock.on("error", () => { sock.destroy(); reject(new Error("not ready")); });
    sock.on("timeout", () => { sock.destroy(); reject(new Error("timeout")); });
    sock.connect(port, "127.0.0.1");
  });
}

async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await checkPort(port);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`Bridge did not start listening on port ${port} within ${timeoutMs}ms`);
}

export async function startBridge(): Promise<BridgeInfo> {
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

  // Wait for bridge to actually listen
  await waitForPort(BRIDGE_PORT);

  return { port: BRIDGE_PORT, token: BRIDGE_TOKEN, process: proc };
}

export function stopBridge(info: BridgeInfo): void {
  info.process.kill("SIGTERM");
}
