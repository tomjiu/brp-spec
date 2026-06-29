/**
 * Native Messaging MCP Client — talks to BRP Bridge via stdin/stdout.
 *
 * Spawns bridge process and communicates using Native Messaging format:
 * 4-byte LE length prefix + JSON-rpc 2.0 payload.
 *
 * This is the same protocol the MCP adapter uses — the correct way
 * for MCP clients to talk to the bridge.
 */

import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

const BRIDGE_BINARY = (() => {
  if (process.env.BRP_BRIDGE_PATH) return process.env.BRP_BRIDGE_PATH;
  const base = path.resolve(__dirname, "../../../bridge/target/release");
  if (process.platform === "win32") return path.join(base, "brp-bridge.exe");
  return path.join(base, "brp-bridge");
})();

export class McpClient {
  private proc: ChildProcess;
  private requestId = 0;
  private pending = new Map<number, { resolve: Function; reject: Function }>();
  private stderr = "";

  constructor() {
    if (!fs.existsSync(BRIDGE_BINARY)) {
      throw new Error(`Bridge binary not found: ${BRIDGE_BINARY}`);
    }

    this.proc = spawn(BRIDGE_BINARY, ["--mode=bridge"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        BRP_WS_ADDR: "127.0.0.1:9817",
      },
    });

    this.proc.on("error", (err: Error) => {
      console.error(`[bridge] spawn error: ${err.message}`);
    });

    this.proc.stderr?.on("data", (d: Buffer) => {
      this.stderr += d.toString();
    });

    this.readLoop();
  }

  private readLoop() {
    let buffer = Buffer.alloc(0);
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const msgLen = buffer.readUInt32LE(0);
        if (buffer.length < 4 + msgLen) break;
        const json = buffer.slice(4, 4 + msgLen).toString();
        buffer = buffer.slice(4 + msgLen);

        try {
          const msg = JSON.parse(json);
          const id = msg.id;
          if (id !== undefined && this.pending.has(id)) {
            const { resolve } = this.pending.get(id)!;
            this.pending.delete(id);
            resolve(msg);
          }
        } catch (e) {
          console.error("[mcp-client] parse error:", e);
        }
      }
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.requestId;
    const msg = { jsonrpc: "2.0", id, method, params };
    const json = Buffer.from(JSON.stringify(msg), "utf-8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(json.length, 0);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Function, reject });
      this.proc.stdin!.write(Buffer.concat([lenBuf, json]));

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 10000);
    });
  }

  close(): void {
    this.proc.kill("SIGTERM");
  }
}
