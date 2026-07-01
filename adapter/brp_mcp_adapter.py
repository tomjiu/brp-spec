"""
BRP MCP Adapter — Exposes BRP Bridge as a standard MCP server for QoderWork.

Architecture (v0.9 — Unified Bridge Discovery):

  AI Client ←→ MCP (stdio) ←→ This Adapter
                                   ↓
                              Discovery
                                   ↓
                         ┌──── Found? ────┐
                         YES               NO
                         ↓                 ↓
                   WS connect to      Spawn Bridge
                   existing Bridge    (NM stdin/stdout)
                         ↓                 ↓
                         └──── Bridge ─────┘
                                   ↓
                             Firefox Extension

Discovery reads the Bridge lockfile to find {pid, port, token}.
If the PID is alive and the port is reachable, the adapter connects
via WebSocket as a `register_client` and sends JSON-RPC directly.
Otherwise, it spawns a new Bridge in NM mode (fallback).

Usage:
  python -X utf8 brp_mcp_adapter.py [--bridge-path /path/to/brp-bridge]
"""

import asyncio
import json
import sys
import os
import struct
import argparse
import logging
from typing import Optional

try:
    from mcp.server.fastmcp import FastMCP
    _mcp_available = True
except ImportError:
    FastMCP = None  # type: ignore
    _mcp_available = False

# ── Logging (stderr only — stdout is MCP protocol) ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("brp-mcp")

# ── Bridge State ──
_bridge_proc: Optional[asyncio.subprocess.Process] = None
_ws_conn = None  # websockets connection when in WS mode
_request_id = 0
_pending: dict[int, asyncio.Future] = {}
_initialized = False
_reader_task: Optional[asyncio.Task] = None
_bridge_auth_token: Optional[str] = None


# ── Bridge Discovery ──

def _lockfile_path() -> str:
    """Platform-specific path to the Bridge lockfile."""
    if sys.platform == "win32":
        localappdata = os.environ.get("LOCALAPPDATA", ".")
        return os.path.join(localappdata, "brp-bridge", "bridge.lock")
    if xdg := os.environ.get("XDG_RUNTIME_DIR"):
        return os.path.join(xdg, "brp-bridge.lock")
    import pwd
    uid = os.getuid()
    return f"/tmp/brp-bridge-{uid}.lock"


def _is_pid_alive(pid: int) -> bool:
    """Check if a process with the given PID is alive."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.windll.kernel32
        SYNCHRONIZE = 0x00100000
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        handle = kernel32.OpenProcess(
            SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid
        )
        if not handle:
            return False
        exit_code = wintypes.DWORD()
        ret = kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
        kernel32.CloseHandle(handle)
        return ret != 0 and exit_code.value == STILL_ACTIVE
    else:
        try:
            os.kill(pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False


async def _try_discover_bridge() -> Optional[tuple[str, str]]:
    """Try to discover an already-running Bridge via lockfile.
    Returns (ws_url, token) if found, None otherwise."""
    path = _lockfile_path()
    if not os.path.exists(path):
        return None

    try:
        with open(path, "r") as f:
            data = json.load(f)
    except Exception:
        return None

    pid = data.get("pid")
    port = data.get("port")
    token = data.get("token")
    if not pid or not port:
        return None

    if not _is_pid_alive(pid):
        log.info("[Discovery] Stale lockfile (PID %d is dead), ignoring", pid)
        return None

    # Verify port is reachable
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection("127.0.0.1", port), timeout=2.0
        )
        writer.close()
    except Exception:
        log.info("[Discovery] Bridge PID %d on port %d not reachable", pid, port)
        return None

    if not token:
        log.info("[Discovery] Lockfile has no token, cannot authenticate")
        return None

    ws_url = f"ws://127.0.0.1:{port}"
    log.info("[Discovery] Found live Bridge (PID=%d, port=%d)", pid, port)
    return (ws_url, token)


async def _connect_ws(ws_url: str, token: str) -> bool:
    """Connect to a Bridge via WebSocket as a register_client."""
    global _ws_conn, _bridge_auth_token
    try:
        import websockets
    except ImportError:
        log.error("websockets library not installed")
        return False

    try:
        _ws_conn = await asyncio.wait_for(
            websockets.connect(ws_url, max_size=16 * 1024 * 1024),
            timeout=5.0,
        )
    except Exception as e:
        log.warning("[Discovery] WS connect failed: %s", e)
        return False

    # Send register_client
    reg_msg = json.dumps({
        "jsonrpc": "2.0",
        "method": "register_client",
        "params": {"token": token},
    })
    await _ws_conn.send(reg_msg)

    # Start WS reader
    global _reader_task
    _reader_task = asyncio.create_task(_read_ws_messages())
    _bridge_auth_token = token
    log.info("[Discovery] Connected to Bridge via WS: %s", ws_url)
    return True


async def _read_ws_messages():
    """Read messages from WS connection and dispatch to pending requests."""
    global _ws_conn
    try:
        async for raw in _ws_conn:
            msg = json.loads(raw)
            msg_id = msg.get("id")
            if msg_id is not None and msg_id in _pending:
                future = _pending.pop(msg_id)
                if not future.done():
                    future.set_result(msg)
                continue
            # Handle notifications
            method = msg.get("method", "")
            if method:
                log.debug("[WS] Notification: %s", method)
    except Exception as e:
        log.warning("[WS] Reader error: %s", e)
    finally:
        _ws_conn = None


async def _ws_send(msg: dict):
    """Send a JSON-RPC message via WebSocket."""
    if not _ws_conn:
        raise Exception("WS connection not established")
    await _ws_conn.send(json.dumps(msg))


# ── NM (Native Messaging) fallback ──

async def _read_bridge_stdout():
    """Read Native Messaging responses from Bridge's stdout."""
    global _bridge_proc
    try:
        while _bridge_proc and _bridge_proc.returncode is None:
            header = await _bridge_proc.stdout.readexactly(4)
            length = struct.unpack("<I", header)[0]
            payload = await _bridge_proc.stdout.readexactly(length)
            msg = json.loads(payload.decode("utf-8"))
            _dispatch_bridge_msg(msg)
    except asyncio.IncompleteReadError:
        log.warning("Bridge stdout closed")
    except Exception as e:
        log.error("Bridge reader error: %s", e)


def _dispatch_bridge_msg(msg: dict):
    """Handle a single bridge message."""
    msg_id = msg.get("id")
    if msg_id is not None and msg_id in _pending:
        future = _pending.pop(msg_id)
        if not future.done():
            future.set_result(msg)
        return

    method = msg.get("method", "")
    if method == "notification/bridge.authToken":
        global _bridge_auth_token
        params = msg.get("params", {})
        _bridge_auth_token = params.get("token")
        log.info("Bridge auth token received (file: %s)", params.get("tokenFile", ""))


async def _nm_send(msg: dict):
    """Write a Native Messaging message to Bridge's stdin."""
    payload = json.dumps(msg).encode("utf-8")
    header = struct.pack("<I", len(payload))
    _bridge_proc.stdin.write(header + payload)
    await _bridge_proc.stdin.drain()


async def _spawn_bridge(bridge_path: str, ws_addr: str):
    """Spawn BRP Bridge as a child process (NM fallback)."""
    global _bridge_proc, _reader_task

    log.info("Spawning BRP Bridge: %s", bridge_path)
    env = os.environ.copy()
    env["BRP_WS_ADDR"] = ws_addr

    _bridge_proc = await asyncio.create_subprocess_exec(
        bridge_path,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    log.info("Bridge started (PID=%d, WS=%s)", _bridge_proc.pid, ws_addr)

    # Read first NM message
    try:
        header = await asyncio.wait_for(_bridge_proc.stdout.readexactly(4), timeout=5.0)
        length = struct.unpack("<I", header)[0]
        payload = await _bridge_proc.stdout.readexactly(length)
        first_msg = json.loads(payload.decode("utf-8"))
        bridge_port = first_msg.get("port")
        bridge_token = first_msg.get("token")
        if bridge_port is not None:
            log.info("Bridge WS port: %s", bridge_port)
            global _bridge_auth_token
            _bridge_auth_token = bridge_token
        else:
            _dispatch_bridge_msg(first_msg)
    except asyncio.TimeoutError:
        log.warning("Bridge did not send port info within 5s")
    except asyncio.IncompleteReadError:
        log.warning("Bridge stdout closed before sending port info")

    _reader_task = asyncio.create_task(_read_bridge_stdout())


async def ensure_bridge(bridge_path: str, ws_addr: str):
    """Ensure we have a connection to a Bridge.
    Tries Discovery first (reuse existing B1 Bridge), falls back to spawning."""
    global _ws_conn, _bridge_proc

    # Already connected?
    if _ws_conn:
        return
    if _bridge_proc and _bridge_proc.returncode is None:
        return

    # ── Step 1: Discovery — try to find an existing Bridge ──
    discovered = await _try_discover_bridge()
    if discovered:
        ws_url, token = discovered
        if await _connect_ws(ws_url, token):
            return  # Connected via WS to existing Bridge

    # ── Step 2: Fallback — spawn a new Bridge ──
    log.info("[Discovery] No existing Bridge found, spawning new one")
    await _spawn_bridge(bridge_path, ws_addr)


# ── Unified request function ──

async def brp_request(method: str, params: dict = None, browser_id: str = None) -> dict:
    """Send a JSON-RPC request to BRP Bridge (via WS or NM) and wait for response."""
    global _request_id

    if not _ws_conn and (not _bridge_proc or _bridge_proc.returncode is not None):
        raise Exception("BRP Bridge is not running")

    _request_id += 1
    req_id = _request_id

    p = params or {}
    if browser_id:
        p["browserId"] = browser_id

    msg = {
        "jsonrpc": "2.0",
        "id": req_id,
        "method": method,
        "params": p,
    }

    loop = asyncio.get_event_loop()
    future = loop.create_future()
    _pending[req_id] = future

    # Send via the active transport
    if _ws_conn:
        await _ws_send(msg)
    else:
        await _nm_send(msg)

    log.info("BRP → %s (id=%d)", method, req_id)

    try:
        resp = await asyncio.wait_for(future, timeout=30)
    except asyncio.TimeoutError:
        _pending.pop(req_id, None)
        raise Exception(f"BRP request timed out: {method}")

    if "error" in resp:
        err = resp["error"]
        raise Exception(f"BRP error: {err.get('message', 'unknown')} (code={err.get('code')})")

    return resp.get("result", {})


async def ensure_initialized():
    """Ensure BRP session is initialized."""
    global _initialized
    if _initialized:
        return

    result = await brp_request("initialize", {
        "protocolVersion": "0.1.0",
        "clientInfo": {"name": "brp-mcp-adapter", "version": "0.3.0"},
        "capabilities": {
            "features": ["interactionTree", "events", "screenshot"],
            "actions": [
                "page.navigate", "page.getInteractionTree", "page.screenshot",
                "page.goBack", "page.goForward", "page.reload", "page.waitForSelector",
                "tab.list", "tab.open", "tab.close", "tab.select",
                "element.click", "element.type", "element.fill", "element.scroll",
                "element.hover", "element.select", "element.getAttribute",
                "keyboard.press",
                "script.execute",
            ],
        },
    })
    _initialized = True
    log.info("BRP session initialized: %s", result.get("sessionId"))


# ── MCP Server ──

if _mcp_available:
    mcp_server = FastMCP("BRP Browser Bridge")
else:
    # Dummy for token CLI mode — decorators are no-ops
    class _DummyMCP:
        def tool(self):
            return lambda f: f
    mcp_server = _DummyMCP()

# Global config (set in main)
_bridge_path = ""
_ws_addr = "127.0.0.1:9817"


async def _ready():
    """Ensure Bridge is running and session is initialized."""
    await ensure_bridge(_bridge_path, _ws_addr)
    # Give Bridge a moment to start WS server
    await asyncio.sleep(0.5)
    await ensure_initialized()


@mcp_server.tool()
async def brp_browser_list() -> str:
    """List all browsers connected to the BRP Bridge (e.g. firefox, zen)."""
    await _ready()
    result = await brp_request("browser.list")
    browsers = result.get("browsers", [])
    if not browsers:
        return "No browsers connected"
    lines = []
    for b in browsers:
        bid = b.get("browserId", "?")
        ua = b.get("userAgent", "")
        ver = b.get("extensionVersion", "")
        lines.append(f"Browser: {bid} (extension v{ver})" + (f" — {ua[:60]}" if ua else ""))
    return "\n".join(lines)


@mcp_server.tool()
async def brp_tab_list(browser_id: str = None) -> str:
    """List all open browser tabs with their IDs, titles, and URLs. Optionally target a specific browser by browser_id (e.g. 'firefox', 'zen')."""
    await _ready()
    result = await brp_request("tab.list", browser_id=browser_id)
    tabs = result.get("tabs", [])
    lines = [f"Tab {t['tabId']}: {t.get('title', '?')} — {t.get('url', '?')}" + (" (active)" if t.get("active") else "") for t in tabs]
    return "\n".join(lines) if lines else "No tabs open"


@mcp_server.tool()
async def brp_tab_open(url: str, browser_id: str = None) -> str:
    """Open a new browser tab at the given URL. Optionally target a specific browser by browser_id."""
    await _ready()
    result = await brp_request("tab.open", {"url": url}, browser_id=browser_id)
    return f"Opened tab {result.get('tabId', '?')} at {url}"


@mcp_server.tool()
async def brp_tab_close(tab_id: int = None, browser_id: str = None) -> str:
    """Close a browser tab by ID. Closes active tab if no ID given. Optionally target a specific browser."""
    await _ready()
    params = {}
    if tab_id is not None:
        params["tabId"] = tab_id
    await brp_request("tab.close", params, browser_id=browser_id)
    return f"Closed tab {tab_id or 'active'}"


@mcp_server.tool()
async def brp_tab_select(tab_id: int = None, page_idx: int = None, browser_id: str = None) -> str:
    """Switch to a browser tab by ID or index. Optionally target a specific browser."""
    await _ready()
    params = {}
    if tab_id is not None:
        params["tabId"] = tab_id
    elif page_idx is not None:
        params["pageIdx"] = page_idx
    result = await brp_request("tab.select", params, browser_id=browser_id)
    return f"Selected tab: {result.get('title', '?')} — {result.get('url', '?')}"


@mcp_server.tool()
async def brp_navigate(url: str, browser_id: str = None) -> str:
    """Navigate the active tab to a URL. Optionally target a specific browser."""
    await _ready()
    await brp_request("page.navigate", {"url": url}, browser_id=browser_id)
    return f"Navigated to {url}"


@mcp_server.tool()
async def brp_snapshot(browser_id: str = None) -> str:
    """Get the Interaction Tree (ITree) of the current page. Optionally target a specific browser."""
    await _ready()
    result = await brp_request("page.getInteractionTree", browser_id=browser_id)
    return _format_itree(result)


@mcp_server.tool()
async def brp_screenshot(browser_id: str = None) -> str:
    """Take a screenshot of the visible area of the active tab. Optionally target a specific browser."""
    await _ready()
    result = await brp_request("page.screenshot", browser_id=browser_id)
    data_url = result.get("dataUrl", "")
    if data_url.startswith("data:image/png;base64,"):
        return f"Screenshot captured (base64 PNG, {len(data_url)} chars)"
    return f"Screenshot: {data_url[:200]}..."


@mcp_server.tool()
async def brp_click(selector: str, selector_type: str = "css", browser_id: str = None) -> str:
    """Click an element on the page. Selector types: css, xpath, text, nodeId. Optionally target a specific browser."""
    await _ready()
    sel = {"type": selector_type, "value": selector}
    result = await brp_request("element.click", {"selector": sel}, browser_id=browser_id)
    if result.get("success"):
        return f"Clicked element ({selector_type}: {selector})"
    return f"Click failed: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_type(selector: str, text: str, selector_type: str = "css", browser_id: str = None) -> str:
    """Type text into an element character by character (simulates keyboard). Optionally target a specific browser."""
    await _ready()
    sel = {"type": selector_type, "value": selector}
    result = await brp_request("element.type", {"selector": sel, "text": text}, browser_id=browser_id)
    if result.get("success"):
        return f"Typed {result.get('typed', len(text))} chars into ({selector_type}: {selector})"
    return f"Type failed: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_fill(selector: str, text: str, selector_type: str = "css", browser_id: str = None) -> str:
    """Fill an input element directly (sets value without simulating keystrokes). Optionally target a specific browser."""
    await _ready()
    sel = {"type": selector_type, "value": selector}
    result = await brp_request("element.fill", {"selector": sel, "text": text}, browser_id=browser_id)
    if result.get("success"):
        return f"Filled {result.get('filled', len(text))} chars into ({selector_type}: {selector})"
    return f"Fill failed: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_scroll(selector: str = None, selector_type: str = "css", browser_id: str = None) -> str:
    """Scroll an element into view. If no selector, scrolls to top of page. Optionally target a specific browser."""
    await _ready()
    params = {}
    if selector:
        params["selector"] = {"type": selector_type, "value": selector}
    result = await brp_request("element.scroll", params, browser_id=browser_id)
    if result.get("success"):
        return "Scrolled element into view"
    return f"Scroll result: {json.dumps(result)}"


@mcp_server.tool()
async def brp_execute(code: str, browser_id: str = None) -> str:
    """Execute JavaScript code in the active page context and return the result. Optionally target a specific browser."""
    await _ready()
    result = await brp_request("script.execute", {"code": code}, browser_id=browser_id)
    if result.get("success"):
        return f"Script result: {json.dumps(result.get('result'), ensure_ascii=False)}"
    return f"Script error: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_hover(selector: str, selector_type: str = "css", browser_id: str = None) -> str:
    """Hover the mouse over an element. Optionally target a specific browser."""
    await _ready()
    sel = {"type": selector_type, "value": selector}
    result = await brp_request("element.hover", {"selector": sel}, browser_id=browser_id)
    if result.get("success"):
        return f"Hovered over element ({selector_type}: {selector})"
    return f"Hover failed: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_select(selector: str, value: str, selector_type: str = "css", browser_id: str = None) -> str:
    """Select an option in a <select> dropdown by value or visible text. Optionally target a specific browser."""
    await _ready()
    sel = {"type": selector_type, "value": selector}
    result = await brp_request("element.select", {"selector": sel, "value": value}, browser_id=browser_id)
    if result.get("success"):
        return f"Selected {result.get('selected', 1)} option(s)"
    return f"Select failed: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_get_attribute(selector: str, attribute: str, selector_type: str = "css", browser_id: str = None) -> str:
    """Get an attribute or property value from an element. Supports: href, class, id, value, textContent, innerHTML, checked, disabled, etc. Optionally target a specific browser."""
    await _ready()
    sel = {"type": selector_type, "value": selector}
    result = await brp_request("element.getAttribute", {"selector": sel, "attribute": attribute}, browser_id=browser_id)
    if result.get("success"):
        return f"{attribute} = {json.dumps(result.get('value'), ensure_ascii=False)}"
    return f"GetAttribute failed: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_key_press(key: str, selector: str = None, selector_type: str = "css", browser_id: str = None) -> str:
    """Press a key or key combination (e.g. 'Enter', 'Control+a', 'Alt+F4', 'Shift+Tab'). Targets the focused element by default, or specify a selector. Optionally target a specific browser."""
    await _ready()
    params = {"key": key}
    if selector:
        params["selector"] = {"type": selector_type, "value": selector}
    result = await brp_request("keyboard.press", params, browser_id=browser_id)
    if result.get("success"):
        return f"Pressed: {key}"
    return f"Key press failed: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_go_back(browser_id: str = None) -> str:
    """Navigate back in browser history. Optionally target a specific browser."""
    await _ready()
    result = await brp_request("page.goBack", browser_id=browser_id)
    if result.get("success"):
        return "Navigated back"
    return f"Go back result: {json.dumps(result)}"


@mcp_server.tool()
async def brp_go_forward(browser_id: str = None) -> str:
    """Navigate forward in browser history. Optionally target a specific browser."""
    await _ready()
    result = await brp_request("page.goForward", browser_id=browser_id)
    if result.get("success"):
        return "Navigated forward"
    return f"Go forward result: {json.dumps(result)}"


@mcp_server.tool()
async def brp_reload(browser_id: str = None) -> str:
    """Reload the current page. Optionally target a specific browser."""
    await _ready()
    result = await brp_request("page.reload", browser_id=browser_id)
    if result.get("success"):
        return "Page reloaded"
    return f"Reload result: {json.dumps(result)}"


@mcp_server.tool()
async def brp_wait_for_selector(css: str, timeout: int = 10000, browser_id: str = None) -> str:
    """Wait for an element matching a CSS selector to appear in the DOM. Default timeout is 10000ms. Optionally target a specific browser."""
    await _ready()
    result = await brp_request("page.waitForSelector", {"css": css, "timeout": timeout}, browser_id=browser_id)
    if result.get("success") and result.get("found"):
        return f"Element found: {css}"
    return f"Wait result: {result.get('error', 'not found')}"


def _format_itree(data: dict) -> str:
    """Format Interaction Tree as human-readable text."""
    if not data:
        return "(empty tree)"

    lines = []
    title = data.get("title", "")
    url = data.get("url", "")
    if title or url:
        lines.append(f"Page: {title} ({url})")
        lines.append(f"Nodes: {data.get('nodeCount', '?')}, Revision: {data.get('revision', '?')}")
        lines.append("")

    root = data.get("root")
    if root:
        _format_node(root, lines, 0)

    return "\n".join(lines) if lines else "(no tree data)"


def _format_node(node: dict, lines: list, depth: int):
    """Recursively format an ITree node."""
    prefix = "  " * depth
    role = node.get("role", "?")
    name = node.get("name", "")
    node_id = node.get("nodeId", "")
    tag = node.get("tag", "")

    parts = [f"{prefix}[{role}]"]
    if name:
        parts.append(f'"{name[:80]}"')
    if node_id:
        parts.append(f"({node_id})")
    if tag and tag != role:
        parts.append(f"<{tag}>")

    val = node.get("value")
    if val:
        parts.append(f'val="{val[:50]}"')

    href = node.get("href")
    if href:
        parts.append(f"→ {href[:80]}")

    lines.append(" ".join(parts))

    for child in node.get("children", []):
        _format_node(child, lines, depth + 1)


# ── Main ──

async def _handle_token_cli(args) -> int:
    """Handle --issue-token / --revoke-token CLI commands."""
    master_token = os.environ.get("BRP_MASTER_TOKEN")
    if not master_token:
        print("Error: BRP_MASTER_TOKEN environment variable is required.", file=sys.stderr)
        return 1

    bridge_path = (
        args.bridge_path
        or os.environ.get("BRP_BRIDGE_PATH")
        or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "bridge", "target", "release", "brp-bridge.exe")
    )
    if not os.path.exists(bridge_path):
        print(f"Error: Bridge binary not found at {bridge_path}", file=sys.stderr)
        return 1

    ws_addr = args.ws_addr or os.environ.get("BRP_WS_ADDR", "127.0.0.1:9817")

    env = os.environ.copy()
    # Pass master token to bridge
    env["BRP_MASTER_TOKEN"] = master_token
    # Use random port to avoid conflicts
    env["BRP_WS_ADDR"] = "127.0.0.1:0"

    print(f"Starting bridge for token operation...", file=sys.stderr)

    proc = await asyncio.create_subprocess_exec(
        bridge_path,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    # Read port/token from first NM message
    try:
        header = await asyncio.wait_for(proc.stdout.readexactly(4), timeout=10.0)
        length = struct.unpack("<I", header)[0]
        payload = await proc.stdout.readexactly(length)
        first_msg = json.loads(payload.decode("utf-8"))
        bridge_port = first_msg.get("port")
        if not bridge_port:
            print(f"Error: Bridge did not send port info: {first_msg}", file=sys.stderr)
            proc.kill()
            return 1
    except Exception as e:
        print(f"Error: Failed to read bridge port: {e}", file=sys.stderr)
        proc.kill()
        return 1

    # Send token.issue or token.revoke via NM protocol
    import uuid
    req_id = str(uuid.uuid4())

    if args.issue_token:
        method = "token.issue"
        params = {"masterToken": master_token}
    else:
        method = "token.revoke"
        params = {"masterToken": master_token, "token": args.revoke_token}

    msg = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
    payload = json.dumps(msg).encode("utf-8")
    header_bytes = struct.pack("<I", len(payload))
    proc.stdin.write(header_bytes + payload)
    await proc.stdin.drain()

    # Read response (skip notifications until we get the matching response)
    resp = None
    try:
        while True:
            resp_header = await asyncio.wait_for(proc.stdout.readexactly(4), timeout=10.0)
            resp_len = struct.unpack("<I", resp_header)[0]
            resp_payload = await proc.stdout.readexactly(resp_len)
            msg = json.loads(resp_payload.decode("utf-8"))

            # Skip notifications (no "id" field, has "method" starting with "notification/")
            if "id" not in msg:
                continue

            # Check if this is the response to our request
            if msg.get("id") != req_id:
                continue

            resp = msg
            break
    except Exception as e:
        print(f"Error: Failed to read response: {e}", file=sys.stderr)
        proc.kill()
        return 1

    if "error" in resp:
        err = resp["error"]
        print(f"Error: {err.get('message', err)}", file=sys.stderr)
        proc.kill()
        return 1

    if args.issue_token:
        token = resp.get("result", {}).get("token")
        if token:
            print(token)
        else:
            print("Error: No token in response", file=sys.stderr)
            proc.kill()
            return 1
    else:
        revoked = resp.get("result", {}).get("revoked")
        if revoked:
            print(f"Token revoked: {args.revoke_token}")
        else:
            print("Error: Token not revoked", file=sys.stderr)
            proc.kill()
            return 1

    # Cleanup
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.kill()
    await proc.wait()
    return 0

def main():
    global _bridge_path, _ws_addr

    parser = argparse.ArgumentParser(description="BRP MCP Adapter")
    parser.add_argument("--bridge-path", default=None,
                        help="Path to brp-bridge binary (overrides BRP_BRIDGE_PATH env)")
    parser.add_argument("--ws-addr", default=None,
                        help="Bridge WebSocket address (overrides BRP_WS_ADDR env)")
    parser.add_argument("--issue-token", action="store_true",
                        help="Issue a new client token using master token, then exit")
    parser.add_argument("--revoke-token", metavar="TOKEN",
                        help="Revoke a client token using master token, then exit")
    args = parser.parse_args()

    # ── B2 Token Management CLI ──
    if args.issue_token or args.revoke_token:
        sys.exit(asyncio.run(_handle_token_cli(args)))

    _bridge_path = (
        args.bridge_path
        or os.environ.get("BRP_BRIDGE_PATH")
        or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "bridge", "target", "release", "brp-bridge.exe")
    )
    _ws_addr = args.ws_addr or os.environ.get("BRP_WS_ADDR", "127.0.0.1:9817")

    if not os.path.exists(_bridge_path):
        log.error("Bridge binary not found at: %s", _bridge_path)
        log.error("Build with: cd bridge && cargo build --release")
        sys.exit(1)

    log.info("BRP MCP Adapter starting")
    log.info("  Bridge: %s", _bridge_path)
    log.info("  WS addr: %s", _ws_addr)

    if not _mcp_available:
        log.error("mcp SDK not installed. Install with: pip install mcp")
        sys.exit(1)

    mcp_server.run(transport="stdio")


if __name__ == "__main__":
    main()
