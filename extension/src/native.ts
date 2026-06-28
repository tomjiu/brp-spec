/** B1 Native Messaging Auto-Link.
 *
 * `startBridge()` launches the BRP Bridge via `browser.runtime.connectNative()`,
 * reads the token + port from its first stdout message, then connects
 * via WebSocket. This replaces manual token provisioning (v0.3.x).
 *
 * Prototype-validated behaviors:
 * - 5a: Extension unload kills bridge (stdin EOF → bridge exits, PR #18)
 * - 5d: Broken native manifest → no token message → 3-second timeout (PR #17)
 *
 * Lifecycle note (Windows):
 * port.disconnect() kills the bridge process (stdin pipe close → OS signal).
 * The native port must stay open while the WebSocket is connected.
 * When the WebSocket closes, disconnect the port so the bridge exits,
 * releasing the single-instance lock for the next reconnection.
 */

const NATIVE_APP_NAME = "org.brp.bridge";
const TOKEN_TIMEOUT_MS = 3000;

/** Token delivery message from bootstrap bridge (Native Messaging format). */
interface BootstrapToken {
  port: number;
  token: string;
}

function isBootstrapToken(msg: unknown): msg is BootstrapToken {
  return (
    typeof msg === "object" &&
    msg !== null &&
    typeof (msg as Record<string, unknown>).port === "number" &&
    typeof (msg as Record<string, unknown>).token === "string"
  );
}

/** Wait for a single message from a Native Messaging port. */
function waitForMessage(port: browser.runtime.Port): Promise<unknown> {
  return new Promise((resolve) => {
    port.onMessage.addListener(function handler(msg: unknown) {
      port.onMessage.removeListener(handler);
      resolve(msg);
    });
  });
}

/** Current active native port. Disconnected before each connectNative call
 *  to ensure the old bridge releases its single-instance lock. */
let activePort: browser.runtime.Port | null = null;

/**
 * B1 Auto-Link: launch bridge via connectNative, read token+port, connect WebSocket.
 *
 * Flow:
 *  1. Disconnect any existing port → kills old bridge, releases lock
 *  2. connectNative → Firefox spawns new bridge
 *  3. Read first message {port, token} with 3-second timeout
 *  4. Connect ws://127.0.0.1:<port>
 *  5. Keep port open (keeps bridge alive). Disconnect when WS closes.
 *
 * Falls back with a user-friendly error if connectNative is unavailable
 * or the 3-second token timeout fires (native manifest not installed).
 */
export async function startBridge(): Promise<WebSocket> {
  // 0. Kill previous bridge if any (releases single-instance lock)
  if (activePort) {
    try { activePort.disconnect(); } catch (_) { /* ignore */ }
    activePort = null;
  }

  // 1. connectNative
  let port: browser.runtime.Port;
  try {
    port = browser.runtime.connectNative(NATIVE_APP_NAME);
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Bridge not installed. Run install.sh (Linux/macOS) or install.ps1 (Windows) first.\n` +
        `Details: ${detail}`
    );
  }

  // 2. Read token message with 3-second timeout (PR #17 prototype 5d)
  const rawMsg: unknown = await Promise.race([
    waitForMessage(port),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => {
          port.disconnect();
          reject(
            new Error(
              "Bridge not installed. Run install.sh (Linux/macOS) or install.ps1 (Windows) first."
            )
          );
        },
        TOKEN_TIMEOUT_MS
      )
    ),
  ]);

  if (!isBootstrapToken(rawMsg)) {
    port.disconnect();
    throw new Error(
      `Unexpected bridge message: expected {port, token}, got ${JSON.stringify(rawMsg)}`
    );
  }

  // 3. Store token to browser.storage.local so registration can use it
  try {
    await browser.storage.local.set({ brpAuthToken: rawMsg.token });
    console.log("[BRP B1] Token stored");
  } catch (e: unknown) {
    console.warn("[BRP B1] Failed to store token:", e instanceof Error ? e.message : String(e));
  }

  // 4. Keep port open — bridge process stays alive for WebSocket session
  activePort = port;

  // 5. Connect WebSocket
  const wsUrl = `ws://127.0.0.1:${rawMsg.port}`;
  console.log("[BRP B1] Connecting WebSocket to", wsUrl);

  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      ws.close();
      disconnectAndClearPort();
      reject(new Error(`Bridge WebSocket connect timeout (${wsUrl})`));
    }, 10000);

    ws.onopen = () => {
      clearTimeout(timeout);
      console.log("[BRP B1] WebSocket connected");
      resolve(ws);
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      disconnectAndClearPort();
      reject(new Error(`Bridge WebSocket connect failed (${wsUrl})`));
    };
  });
}

function disconnectAndClearPort(): void {
  if (activePort) {
    try { activePort.disconnect(); } catch (_) { /* ignore */ }
    activePort = null;
  }
}

/** Disconnect native port — kills bridge, releases single-instance lock.
 *  Call this from background.ts when WebSocket closes. */
export function releaseBridge(): void {
  disconnectAndClearPort();
}
