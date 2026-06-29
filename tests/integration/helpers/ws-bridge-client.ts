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
    // Wait a moment for bridge to start listening
    await new Promise((r) => setTimeout(r, 1000));

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

      this.ws.on("open", () => {
        console.log("[ws-client] connected to bridge");
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
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

      this.ws.on("error", (err: Error) => {
        console.error(`[ws-client] error: ${err.message}`);
        reject(err);
      });

      setTimeout(() => reject(new Error("WS connect timeout")), 5000);
    });
  }

  async ready(): Promise<void> {
    return this.readyPromise;
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
