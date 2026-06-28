/**
 * MCP Client helper — connects to BRP Bridge via WebSocket
 * and sends JSON-RPC 2.0 requests.
 */

import WebSocket from "ws";

export class McpClient {
  private ws: WebSocket;
  private requestId: number = 0;
  private pending: Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = new Map();

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
  }

  async connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS connect timeout")), timeoutMs);
      this.ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          const id = msg.id;
          if (id !== undefined && this.pending.has(id)) {
            const { resolve } = this.pending.get(id)!;
            this.pending.delete(id);
            resolve(msg);
          }
        } catch {
          // ignore parse errors
        }
      });
    });
  }

  async initialize(): Promise<Record<string, unknown>> {
    return this.send("initialize", {
      protocolVersion: "0.1.0",
      clientInfo: { name: "brp-integration-test", version: "0.4.2" },
      capabilities: {
        features: ["interactionTree", "events", "screenshot"],
        actions: ["page.*", "tab.*", "element.click"],
      },
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.requestId;
    const msg = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws.send(JSON.stringify(msg));

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 10000);
    });
  }

  close(): void {
    this.ws.close();
  }
}
