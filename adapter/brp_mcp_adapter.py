"""
BRP MCP Adapter — Exposes BRP Bridge as a standard MCP server for QoderWork.

Architecture:
  QoderWork ←→ MCP (stdio) ←→ This Adapter ←→ WebSocket ←→ BRP Bridge ←→ Firefox Extension

Usage:
  python -X utf8 brp_mcp_adapter.py [--ws-url ws://127.0.0.1:9817]
"""

import asyncio
import json
import sys
import argparse
import logging
from typing import Any

import os
import websockets
from mcp.server.fastmcp import FastMCP

# ── Logging ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,  # MCP uses stdout for protocol, logs go to stderr
)
log = logging.getLogger("brp-mcp")

# ── BRP Connection State ──
_bridge_ws = None
_bridge_ws_url = "ws://127.0.0.1:9817"
_request_id = 10000
_pending: dict[int, asyncio.Future] = {}
_initialized = False


async def get_bridge():
    """Get or create WebSocket connection to BRP Bridge."""
    global _bridge_ws

    if _bridge_ws and _bridge_ws.open:
        return _bridge_ws

    log.info("Connecting to BRP Bridge at %s", _bridge_ws_url)
    _bridge_ws = await websockets.connect(_bridge_ws_url)
    log.info("Connected to BRP Bridge")

    # Start background message reader
    asyncio.create_task(_read_bridge_messages())

    return _bridge_ws


async def _read_bridge_messages():
    """Background task: read messages from Bridge and resolve pending futures."""
    global _bridge_ws
    try:
        async for raw in _bridge_ws:
            msg = json.loads(raw)

            # Response to a pending request?
            msg_id = msg.get("id")
            if msg_id is not None and msg_id in _pending:
                future = _pending.pop(msg_id)
                if not future.done():
                    future.set_result(msg)
                continue

            # Notification from Bridge → log it (could forward as MCP notification)
            method = msg.get("method", "")
            if method.startswith("notification/"):
                log.info("BRP notification: %s", method)
    except Exception as e:
        log.error("Bridge message reader error: %s", e)
        _bridge_ws = None


async def brp_request(method: str, params: dict = None) -> dict:
    """Send a JSON-RPC request to BRP Bridge and wait for response."""
    global _request_id

    ws = await get_bridge()

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

    await ws.send(json.dumps(msg))
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


@mcp_server.tool()
async def brp_tab_list() -> str:
    """List all open browser tabs with their IDs, titles, and URLs."""
    await ensure_initialized()
    result = await brp_request("tab.list")
    tabs = result.get("tabs", [])
    lines = [f"Tab {t['tabId']}: {t.get('title', '?')} — {t.get('url', '?')}" + (" (active)" if t.get("active") else "") for t in tabs]
    return "\n".join(lines) if lines else "No tabs open"


@mcp_server.tool()
async def brp_tab_open(url: str) -> str:
    """Open a new browser tab at the given URL."""
    await ensure_initialized()
    result = await brp_request("tab.open", {"url": url})
    return f"Opened tab {result.get('tabId', '?')} at {url}"


@mcp_server.tool()
async def brp_tab_close(tab_id: int = None) -> str:
    """Close a browser tab by ID. Closes active tab if no ID given."""
    await ensure_initialized()
    params = {}
    if tab_id is not None:
        params["tabId"] = tab_id
    await brp_request("tab.close", params)
    return f"Closed tab {tab_id or 'active'}"


@mcp_server.tool()
async def brp_tab_select(tab_id: int = None, page_idx: int = None) -> str:
    """Switch to a browser tab by ID or index."""
    await ensure_initialized()
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
    await ensure_initialized()
    await brp_request("page.navigate", {"url": url})
    return f"Navigated to {url}"


@mcp_server.tool()
async def brp_snapshot() -> str:
    """Get the Interaction Tree (ITree) of the current page — a structured representation of interactive elements."""
    await ensure_initialized()
    result = await brp_request("page.getInteractionTree")
    # Format as readable text
    return _format_itree(result)


@mcp_server.tool()
async def brp_screenshot() -> str:
    """Take a screenshot of the visible area of the active tab. Returns a data URL."""
    await ensure_initialized()
    result = await brp_request("page.screenshot")
    data_url = result.get("dataUrl", "")
    if data_url.startswith("data:image/png;base64,"):
        return f"Screenshot captured (base64 PNG, {len(data_url)} chars)"
    return f"Screenshot: {data_url[:200]}..."


@mcp_server.tool()
async def brp_click(selector: str, selector_type: str = "css") -> str:
    """Click an element on the page. Selector types: css, xpath, text, nodeId."""
    await ensure_initialized()
    sel = {"type": selector_type, "value": selector}
    result = await brp_request("element.click", {"selector": sel})
    if result.get("success"):
        return f"Clicked element ({selector_type}: {selector})"
    return f"Click failed: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_type(selector: str, text: str, selector_type: str = "css") -> str:
    """Type text into an element character by character (simulates keyboard)."""
    await ensure_initialized()
    sel = {"type": selector_type, "value": selector}
    result = await brp_request("element.type", {"selector": sel, "text": text})
    if result.get("success"):
        return f"Typed {result.get('typed', len(text))} chars into ({selector_type}: {selector})"
    return f"Type failed: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_fill(selector: str, text: str, selector_type: str = "css") -> str:
    """Fill an input element directly (sets value without simulating keystrokes)."""
    await ensure_initialized()
    sel = {"type": selector_type, "value": selector}
    result = await brp_request("element.fill", {"selector": sel, "text": text})
    if result.get("success"):
        return f"Filled {result.get('filled', len(text))} chars into ({selector_type}: {selector})"
    return f"Fill failed: {result.get('error', 'unknown')}"


@mcp_server.tool()
async def brp_scroll(selector: str = None, selector_type: str = "css") -> str:
    """Scroll an element into view. If no selector, scrolls to top of page."""
    await ensure_initialized()
    params = {}
    if selector:
        params["selector"] = {"type": selector_type, "value": selector}
    result = await brp_request("element.scroll", params)
    if result.get("success"):
        return f"Scrolled element into view"
    return f"Scroll result: {json.dumps(result)}"


@mcp_server.tool()
async def brp_execute(code: str) -> str:
    """Execute JavaScript code in the active page context and return the result."""
    await ensure_initialized()
    result = await brp_request("script.execute", {"code": code})
    if result.get("success"):
        return f"Script result: {json.dumps(result.get('result'), ensure_ascii=False)}"
    return f"Script error: {result.get('error', 'unknown')}"


def _format_itree(data: dict, indent: int = 0) -> str:
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

    # Show value for inputs
    val = node.get("value")
    if val:
        parts.append(f'val="{val[:50]}"')

    # Show href for links
    href = node.get("href")
    if href:
        parts.append(f"→ {href[:80]}")

    lines.append(" ".join(parts))

    for child in node.get("children", []):
        _format_node(child, lines, depth + 1)


# ── Main ──

def main():
    parser = argparse.ArgumentParser(description="BRP MCP Adapter")
    parser.add_argument("--ws-url", default=None,
                        help="BRP Bridge WebSocket URL (overrides BRP_WS_URL env)")
    args = parser.parse_args()

    global _bridge_ws_url
    _bridge_ws_url = args.ws_url or os.environ.get("BRP_WS_URL", "ws://127.0.0.1:9817")

    log.info("BRP MCP Adapter starting (bridge=%s)", _bridge_ws_url)
    mcp_server.run(transport="stdio")


if __name__ == "__main__":
    main()
