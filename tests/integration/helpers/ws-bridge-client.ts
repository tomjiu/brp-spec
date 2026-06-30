/**
 * v0.7.0 — WebSocket Bridge Client
 *
 * Starts Bridge in standalone WS mode and communicates via JSON-RPC over WebSocket,
 * the same protocol the MCP adapter uses.
 *
 * Unlike the native messaging client (mcp-client.ts), this connects directly
 * to the Bridge WS port — useful for integration tests that simulate an
 * MCP adapter talking to the Bridge.
 */

import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import WebSocket from "ws";

const BRIDGE_BINARY = (() => {
  if (process.env.BRP_BRIDGE_PATH) return process.env.BRP_BRIDGE_PATH;
  const base = path.resolve(__dirname, "../../../bridge/target/release");
  if (process.platform === "win32") return path.join(base, "brp-bridge.exe");
  return path.join(base, "brp-bridge");
})();

export class WsBridgeClient {
  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: Function; reject: Function }>();
  private readyPromise: Promise<void>;
  private port: number;

  constructor(port = 9817) {
    this.port = port;

    if (!fs.existsSync(BRIDGE_BINARY)) {
      throw new Error(`Bridge binary not found: ${BRIDGE_BINARY}. Run: cd bridge && cargo build --release`);
    }

    // Start bridge in standalone mode (WS only, no stdin/stdout native messaging)
    this.proc = spawn(BRIDGE_BINARY, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        BRP_STANDALONE: "1",
        BRP_WS_ADDR: `127.0.0.1:${this.port}`,
        BRP_AUTH_TOKEN: "test-token",
      },
    });

    this.proc.on("error", (err: Error) => {
      console.error(`[bridge] spawn error: ${err.message}`);
    });

    this.proc.stderr?.on("data", (d: Buffer) => {
      // Bridge logs to stderr in standalone mode
      const msg = d.toString().trim();
      if (msg) console.log(`[bridge] ${msg}`);
    });

    // Connect WS
    this.readyPromise = this.connect();
  }

  private async connect(): Promise<void> {
    // Poll for bridge port availability (max 5s, 50 attempts × 100ms)
    const maxAttempts = 50;
    const intervalMs = 100;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("WS connect timeout"));
          }, 1000);

          this.ws!.on("open", () => {
            clearTimeout(timeout);
            console.log("[ws-client] connected to bridge");
            resolve();
          });

          this.ws!.on("error", (err: Error) => {
            clearTimeout(timeout);
            reject(err);
          });
        });

        // Connection succeeded — set up message handler + register
        this.ws!.on("message", (data: WebSocket.Data) => {
          try {
            const msg = JSON.parse(data.toString());
            const id = msg.id;
            if (id !== undefined && this.pending.has(id)) {
              const { resolve } = this.pending.get(id)!;
              this.pending.delete(id);
              resolve(msg);
            }
          } catch {
            // ignore non-JSON messages
          }
        });

        await this.register();
        return; // success
      } catch {
        // Bridge not ready yet, retry after interval
        if (i < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, intervalMs));
        } else {
          throw new Error(`Bridge not reachable on port ${this.port} after ${maxAttempts * intervalMs}ms`);
        }
      }
    }
  }

  async ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Send register as first WS message (Bridge protocol requirement).
   * Bridge rejects any first message that is not a "register".
   */
  private async register(): Promise<void> {
    const token = process.env.BRP_AUTH_TOKEN || "test-token";
    const registerMsg = {
      jsonrpc: "2.0",
      method: "register",
      params: { token, browserId: "test-client" },
    };
    this.ws!.send(JSON.stringify(registerMsg));
    // Bridge doesn't send a JSON-RPC response for register — it just
    // logs "Extension authenticated" and starts accepting requests.
    // Small delay to let bridge process the register before we send requests.
    await new Promise((r) => setTimeout(r, 500));
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.readyPromise;

    const id = ++this.requestId;
    const msg = { jsonrpc: "2.0", id, method, params };
    const json = JSON.stringify(msg);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Function, reject });
      this.ws!.send(json);

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 10000);
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }
}
