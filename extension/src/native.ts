/** B1 Native Messaging Auto-Link.
 *
 * `startBridge()` launches the BRP Bridge via `browser.runtime.connectNative()`,
 * reads the token + port from its first stdout message, then connects
 * via WebSocket. This replaces manual token provisioning (v0.3.x).
 *
 * Prototype-validated behaviors:
 * - 5a: Extension unload kills bridge (stdin EOF → bridge exits, PR #18)
 * - 5d: Broken native manifest → no token message → 3-second timeout (PR #17)
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

/**
 * B1 Auto-Link: launch bridge via connectNative, read token+port, connect WebSocket.
 *
 * Flow:
 *  1. connectNative → Firefox spawns bridge
 *  2. Read first message {port, token} with 3-second timeout
 *  3. Connect ws://127.0.0.1:<port>
 *
 * Falls back with a user-friendly error if connectNative is unavailable
 * or the 3-second token timeout fires (native manifest not installed).
 */
export async function startBridge(): Promise<WebSocket> {
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
        () =>
          reject(
            new Error(
              "Bridge not installed. Run install.sh (Linux/macOS) or install.ps1 (Windows) first."
            )
          ),
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

  // 3. Close connectNative port — token received, WebSocket next
  // port.disconnect();  // TEMP: keep port open to prevent bridge stdin EOF (B1 race condition fix)

  // 4. Connect WebSocket
  const wsUrl = `ws://127.0.0.1:${rawMsg.port}`;
  console.log("[BRP B1] Connecting WebSocket to", wsUrl);

  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Bridge WebSocket connect timeout (${wsUrl})`));
    }, 10000); // 10 seconds for WS connect

    ws.onopen = () => {
      clearTimeout(timeout);
      console.log("[BRP B1] WebSocket connected");
      resolve(ws);
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`Bridge WebSocket connect failed (${wsUrl})`));
    };
  });
}
