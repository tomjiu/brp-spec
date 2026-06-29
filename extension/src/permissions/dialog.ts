/**
 * E1 Permission Gating — Dialog UI
 *
 * Injects a lightweight modal overlay into the active page
 * when the user needs to confirm a sensitive action.
 *
 * Injected by background.ts via browser.tabs.executeScript or
 * browser.tabs.sendMessage to a content script helper.
 */

const DIALOG_ID = "brp-permission-dialog";
const OVERLAY_ID = "brp-permission-overlay";

export interface DialogRequest {
  requestId: string;
  title: string;
  description: string;
  details?: string;
}

/**
 * Show a permission dialog and return user decision.
 */
export function showPermissionDialog(req: DialogRequest): Promise<"allow" | "deny"> {
  return new Promise((resolve) => {
    removeExistingDialog();

    const overlay = createOverlay();
    const dialog = createDialogElement(req, resolve);

    document.body.appendChild(overlay);
    document.body.appendChild(dialog);

    // Focus the deny button by default (safe default)
    const denyBtn = dialog.querySelector(".brp-deny-btn") as HTMLButtonElement;
    denyBtn?.focus();
  });
}

export function removeExistingDialog(): void {
  document.getElementById(DIALOG_ID)?.remove();
  document.getElementById(OVERLAY_ID)?.remove();
}

function createOverlay(): HTMLDivElement {
  const el = document.createElement("div");
  el.id = OVERLAY_ID;
  Object.assign(el.style, {
    position: "fixed",
    inset: "0",
    backgroundColor: "rgba(0, 0, 0, 0.35)",
    zIndex: "2147483646",
  });
  return el;
}

function createDialogElement(
  req: DialogRequest,
  resolve: (decision: "allow" | "deny") => void,
): HTMLDivElement {
  const el = document.createElement("div");
  el.id = DIALOG_ID;
  Object.assign(el.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    zIndex: "2147483647",
    backgroundColor: "#fff",
    borderRadius: "12px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
    padding: "24px 28px",
    minWidth: "360px",
    maxWidth: "480px",
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    color: "#1a1a1a",
  });

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="font-size:24px">🛡️</span>
      <h2 style="margin:0;font-size:16px;font-weight:600">BRP Permission Gate</h2>
    </div>
    <p style="margin:0 0 6px;font-size:14px;color:#333">${escapeHtml(req.title)}</p>
    <p style="margin:0 0 14px;font-size:13px;color:#666;line-height:1.5">${escapeHtml(req.description)}</p>
    ${req.details ? `<p style="margin:0 0 16px;padding:8px;background:#f5f5f5;border-radius:6px;font-family:monospace;font-size:12px;color:#555;word-break:break-all">${escapeHtml(req.details)}</p>` : ""}
    <div style="display:flex;justify-content:flex-end;gap:8px">
      <button class="brp-allow-btn" style="padding:8px 20px;border:1px solid #4CAF50;border-radius:6px;background:#4CAF50;color:#fff;font-size:13px;cursor:pointer;font-weight:500">Allow</button>
      <button class="brp-deny-btn" style="padding:8px 20px;border:1px solid #eee;border-radius:6px;background:#f5f5f5;color:#333;font-size:13px;cursor:pointer">Deny</button>
    </div>
  `;

  el.querySelector(".brp-allow-btn")?.addEventListener("click", () => {
    removeExistingDialog();
    resolve("allow");
  });
  el.querySelector(".brp-deny-btn")?.addEventListener("click", () => {
    removeExistingDialog();
    resolve("deny");
  });

  return el;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
