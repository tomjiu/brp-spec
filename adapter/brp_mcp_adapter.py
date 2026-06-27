"""
BRP MCP Adapter — Exposes BRP Bridge as a standard MCP server for QoderWork.

Architecture:
  QoderWork ←→ MCP (stdio) ←→ This Adapter ←→ stdin/stdout (Native Messaging) ←→ BRP Bridge ←→ WS ←→ Firefox Extension

The adapter spawns brp-bridge as a child process and communicates via
Native Messaging format (4-byte LE length prefix + JSON-RPC).
The Bridge runs its WS server; the Firefox Extension connects to it.

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

from mcp.server.fastmcp import FastMCP

# ── Logging (stderr only — stdout is MCP protocol) ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("brp-mcp")

# ── Bridge Process State ──
_bridge_proc: Optional[asyncio.subprocess.Process] = None
_request_id = 0
_pending: dict[int, asyncio.Future] = {}
_initialized = False
_reader_task: Optional[asyncio.Task] = None


async def ensure_bridge(bridge_path: str, ws_addr: str):
    """Spawn BRP Bridge as a child process if not already running."""
    global _bridge_proc, _reader_task

    if _bridge_proc and _bridge_proc.returncode is None:
        return

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

    # Start background reader for Bridge stdout
    _reader_task = asyncio.create_task(_read_bridge_stdout())


async def _read_bridge_stdout():
    """Read Native Messaging responses from Bridge's stdout."""
    global _bridge_proc
    try:
        while _bridge_proc and _bridge_proc.returncode is None:
            # Read 4-byte length prefix
            header = await _bridge_proc.stdout.readexactly(4)
            length = struct.unpack("<I", header)[0]

            # Read JSON payload
            payload = await _bridge_proc.stdout.readexactly(length)
            msg = json.loads(payload.decode("utf-8"))

            msg_id = msg.get("id")
            if msg_id is not None and msg_id in _pending:
                future = _pending.pop(msg_id)
                if not future.done():
                    future.set_result(msg)
                continue

            # Notification
            method = msg.get("method", "")
            if method.startswith("notification/"):
                log.info("BRP notification: %s", method)
            else:
                log.debug("Unhandled bridge message: %s", msg)

    except asyncio.IncompleteReadError:
        log.warning("Bridge stdout closed")
    except Exception as e:
        log.error("Bridge reader error: %s", e)


async def _send_to_bridge(msg: dict):
    """Write a Native Messaging message to Bridge's stdin."""
    payload = json.dumps(msg).encode("utf-8")
    header = struct.pack("<I", len(payload))
    _bridge_proc.stdin.write(header + payload)
    await _bridge_proc.stdin.drain()


async def brp_request(method: str, params: dict = None) -> dict:
    """Send a JSON-RPC request to BRP Bridge and wait for response."""
    global _request_id

    if not _bridge_proc or _bridge_proc.returncode is not None:
        raise Exception("BRP Bridge is not running")

    _request_id += 1
    req_id = _request_id

    msg = {
        "jsonrpc": "2.0",
        "id": req_id,
        "method": method,
        "params": params or {},
    }

    loop = asyncio.get_event_loop()
    future = loop.create_future()
    _pending[req_id] = future

    await _send_to_bridge(msg)
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
        "clientInfo": {"name": "brp-mcp-adapter", "version": "0.1.0"},
        "capabilities": {
            "features": ["interactionTree", "events", "screenshot"],
            "actions": [
                "page.navigate", "page.getInteractionTree", "page.screenshot",
                "tab.list", "tab.open", "tab.close", "tab.select",
                "element.click", "element.type", "element.fill", "element.scroll",
                "script.execute",
            ],
        },
    })
    _initialized = True
    log.info("BRP session initialized: %s", result.get("sessionId"))


# ── MCP Server ──

mcp_server = FastMCP("BRP Browser Bridge")

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
async def brp_tab_list() -> str:
    """List all open browser tabs with their IDs, titles, and URLs."""
    await _ready()
    result = await brp_request("tab.list")
    tabs = result.get("tabs", [])
    lines = [f"Tab {t['tabId']}: {t.get('title', '?')} — {t.get('url', '?')}" + (" (active)" if t.get("active") else "") for t in tabs]
    return "\n".join(lines) if lines else "No tabs open"


@mcp_server.tool()
async def brp_tab_open(url: str) -> str:
    """Open a new browser tab at the given URL."""
    await _ready()
    result = await brp_request("tab.open", {"url": url})
    return f"Opened tab {result.get('tabId', '?')} at {url}"


@mcp_server.tool()
async def brp_tab_close(tab_id: int = None) -> str:
    """Close a browser tab by ID. Closes active tab if no ID given."""
    await _ready()
    params = {}
    if tab_id is not None:
        params["tabId"] = tab_id
    await brp_request("tab.close", params)
    return f"Closed tab {tab_id or 'active'}"


@mcp_server.tool()
async def brp_tab_select(tab_id: int = None, page_idx: int = None) -> str:
    """Switch to a browser tab by ID or index."""
    await _ready()
    params = {}
    if tab_id is not None:
        params["tabId"] = tab_id
    elif page_idx is not None:
        params["pageIdx"] = page_idx
    result = await brp_request("tab.select", params)
    return f"Selected tab: {result.get('title', '?')} — {result.get('url', '?')}"


@mcp_server.tool()
async def brp_navigate(url: str) -> str:
    """Navigate the active tab to a URL."""
    await _ready()
    await brp_request("page.navigate", {"url": url})
    return f"Navigated to {url}"


@mcp_server.tool()
async def brp_snapshot() -> str:
    """Get the Interaction Tree (ITree) of the current page — a structured representation of interactive elements with roles, names, and nodeIds."""
    await _ready()
    result = await brp_request("page.getInteractionTree")
    return _format_itree(result)


@mcp_server.tool()
async def brp_screenshot() -> str:
    """Take a screenshot of the visible area of the active tab. Returns info about the captured image."""
    await _ready()
    result = await brp_request("page.screenshot")
    data_url = result.get("dataUrl", "")
    if data_url.startswith("data:image/png;base64,"):
        return f"Screenshot captured (base64 PNG, {len(data_url)} chars)"
    return f"Screenshot: {data_url[:200]}..."


@mcp_server.tool()
async def brp_click(selector: str, selector_type: str = "css") -> str:
    """Click an element on the page. Selector types: css, xpath, text, nodeId."""
    await _ready()
    sel = {"type": selector_type, "value": selector}
    result = await brp_request("element.click", {"selector": sel})
    if result.get("success"):
        return f"Clicked element ({selector_type}: {selector})"
    return f"Click failed: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_type(selector: str, text: str, selector_type: str = "css") -> str:
    """Type text into an element character by character (simulates keyboard)."""
    await _ready()
    sel = {"type": selector_type, "value": selector}
    result = await brp_request("element.type", {"selector": sel, "text": text})
    if result.get("success"):
        return f"Typed {result.get('typed', len(text))} chars into ({selector_type}: {selector})"
    return f"Type failed: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_fill(selector: str, text: str, selector_type: str = "css") -> str:
    """Fill an input element directly (sets value without simulating keystrokes)."""
    await _ready()
    sel = {"type": selector_type, "value": selector}
    result = await brp_request("element.fill", {"selector": sel, "text": text})
    if result.get("success"):
        return f"Filled {result.get('filled', len(text))} chars into ({selector_type}: {selector})"
    return f"Fill failed: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_scroll(selector: str = None, selector_type: str = "css") -> str:
    """Scroll an element into view. If no selector, scrolls to top of page."""
    await _ready()
    params = {}
    if selector:
        params["selector"] = {"type": selector_type, "value": selector}
    result = await brp_request("element.scroll", params)
    if result.get("success"):
        return "Scrolled element into view"
    return f"Scroll result: {json.dumps(result)}"


@mcp_server.tool()
async def brp_execute(code: str) -> str:
    """Execute JavaScript code in the active page context and return the result."""
    await _ready()
    result = await brp_request("script.execute", {"code": code})
    if result.get("success"):
        return f"Script result: {json.dumps(result.get('result'), ensure_ascii=False)}"
    return f"Script error: {result.get('error', 'unknown')}"


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

def main():
    global _bridge_path, _ws_addr

    parser = argparse.ArgumentParser(description="BRP MCP Adapter")
    parser.add_argument("--bridge-path", default=None,
                        help="Path to brp-bridge binary (overrides BRP_BRIDGE_PATH env)")
    parser.add_argument("--ws-addr", default=None,
                        help="Bridge WebSocket address (overrides BRP_WS_ADDR env)")
    args = parser.parse_args()

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

    mcp_server.run(transport="stdio")


if __name__ == "__main__":
    main()
