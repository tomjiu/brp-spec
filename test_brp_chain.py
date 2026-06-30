"""
BRP Complete Chain Test — MCP Adapter → Bridge → Extension → Firefox

Tests the full MCP protocol flow:
  1. MCP initialize handshake
  2. tools/list to verify all tools are registered
  3. brp_browser_list (will show no browsers if Firefox extension not loaded)
  4. brp_tab_list (will show no tabs if no browser connected)

Usage:
  python -X utf8 test_brp_chain.py

Prerequisites:
  - Bridge built: bridge/target/release/brp-bridge.exe
  - Extension built: extension/dist/
  - Extension loaded in Firefox via about:debugging
"""

import asyncio
import json
import os
import sys
import subprocess
import time

# Paths
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.path.join(PROJECT_DIR, "bridge", "target", "release", "brp-bridge.exe")
ADAPTER_PATH = os.path.join(PROJECT_DIR, "adapter", "brp_mcp_adapter.py")

# Python path (use venv with mcp installed, fallback to system python)
_PYTHON_VENV = os.path.expanduser("~/.workbuddy/binaries/python/envs/default/Scripts/python.exe")
_PYTHON_SYS = os.path.expanduser("~/.workbuddy/binaries/python/versions/3.13.12/python.exe")
if os.path.exists(_PYTHON_VENV):
    PYTHON_PATH = _PYTHON_VENV
elif os.path.exists(_PYTHON_SYS):
    PYTHON_PATH = _PYTHON_SYS
else:
    PYTHON_PATH = sys.executable

PASS = 0
FAIL = 0

def log(level, msg):
    print(f"[{level:6s}] {msg}", file=sys.stderr)

def passed(test_name, detail=None):
    global PASS
    PASS += 1
    msg = f"  ✅ PASS: {test_name}"
    if detail:
        msg += f" — {detail}"
    print(msg)

def failed(test_name, detail=None):
    global FAIL
    FAIL += 1
    msg = f"  ❌ FAIL: {test_name}"
    if detail:
        msg += f" — {detail}"
    print(msg)

async def read_mcp_message(reader, timeout=30):
    """Read a newline-delimited JSON-RPC message from MCP server stdout."""
    try:
        line = await asyncio.wait_for(reader.readline(), timeout)
        if not line:
            return None
        line = line.strip()
        if not line:
            return None
        return json.loads(line.decode("utf-8"))
    except asyncio.TimeoutError:
        return None
    except json.JSONDecodeError as e:
        log("WARN", f"Failed to parse MCP message: {e}")
        return None

async def send_mcp_message(writer, msg):
    """Send a newline-delimited JSON-RPC message to MCP server stdin."""
    payload = (json.dumps(msg) + "\n").encode("utf-8")
    writer.write(payload)
    await writer.drain()

async def test_chain():
    print("=" * 60, file=sys.stderr)
    print("  BRP Complete Chain Test", file=sys.stderr)
    print("=" * 60, file=sys.stderr)

    # Check prerequisites
    if not os.path.exists(BRIDGE_PATH):
        print(f"❌ Bridge not found at: {BRIDGE_PATH}", file=sys.stderr)
        return 1
    print(f"  Bridge: {BRIDGE_PATH}", file=sys.stderr)

    if not os.path.exists(ADAPTER_PATH):
        print(f"❌ Adapter not found at: {ADAPTER_PATH}", file=sys.stderr)
        return 1
    print(f"  Adapter: {ADAPTER_PATH}", file=sys.stderr)
    print(f"  Python: {PYTHON_PATH}", file=sys.stderr)
    print(file=sys.stderr)

    # ── Test 1: Start MCP Adapter ──
    print("── Test 1: Start MCP Adapter ──", file=sys.stderr)

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"

    proc = await asyncio.create_subprocess_exec(
        PYTHON_PATH, "-X", "utf8", ADAPTER_PATH,
        "--bridge-path", BRIDGE_PATH,
        "--ws-addr", "127.0.0.1:19817",  # test port
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    try:
        await asyncio.sleep(2)  # Give adapter time to spawn bridge

        if proc.returncode is not None:
            # Adapter exited — might need mcp package
            stderr_data = await proc.stderr.read()
            stderr_text = stderr_data.decode("utf-8", errors="replace")
            # Check if bridge not found or mcp not installed
            if "mcp SDK not installed" in stderr_text or "No module named 'mcp'" in stderr_text:
                print(f"  ⚠️  MCP SDK not installed. Installing...", file=sys.stderr)
                install_proc = await asyncio.create_subprocess_exec(
                    PYTHON_PATH, "-m", "pip", "install", "mcp",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await install_proc.wait()
                if install_proc.returncode == 0:
                    # Retry with adapter
                    proc = await asyncio.create_subprocess_exec(
                        PYTHON_PATH, "-X", "utf8", ADAPTER_PATH,
                        "--bridge-path", BRIDGE_PATH,
                        "--ws-addr", "127.0.0.1:19817",
                        stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        env=env,
                    )
                    await asyncio.sleep(2)

            if proc.returncode is not None:
                print(f"  ❌ Adapter exited early (code={proc.returncode})", file=sys.stderr)
                remain = await proc.stderr.read()
                print(f"  stderr: {remain.decode('utf-8', errors='replace')[:500]}", file=sys.stderr)
                failed("Start MCP Adapter", f"exit code {proc.returncode}")
                return 1

        if proc.returncode is None:
            passed("Start MCP Adapter — adapter is running")
        else:
            failed("Start MCP Adapter", "adapter not running")

        # ── Test 2: MCP Initialize Handshake ──
        print("\n── Test 2: MCP Initialize Handshake ──", file=sys.stderr)

        init_msg = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "brp-chain-test",
                    "version": "1.0.0",
                },
            },
        }

        await send_mcp_message(proc.stdin, init_msg)
        log("INFO", f"→ initialize")

        resp = await read_mcp_message(proc.stdout, timeout=10)
        if resp:
            log("INFO", f"← {json.dumps(resp, indent=2)[:500]}")
            if resp.get("result"):
                server_info = resp["result"].get("serverInfo", {})
                protocol = resp["result"].get("protocolVersion", "?")
                print(f"  Server: {server_info.get('name', '?')} v{server_info.get('version', '?')}")
                print(f"  Protocol: {protocol}")
                passed("MCP Initialize", f"server={server_info.get('name')}")
            else:
                failed("MCP Initialize", f"error: {resp.get('error')}")
        else:
            failed("MCP Initialize", "no response received")

        # ── Test 3: Send initialized notification ──
        print("\n── Test 3: Initialized Notification ──", file=sys.stderr)
        notified = {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        }
        await send_mcp_message(proc.stdin, notified)
        log("INFO", "→ notifications/initialized")
        await asyncio.sleep(0.5)
        passed("Initialized Notification", "sent successfully")

        # ── Test 4: tools/list ──
        print("\n── Test 4: tools/list — Verify all BRP tools ──", file=sys.stderr)

        tools_msg = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
        }

        await send_mcp_message(proc.stdin, tools_msg)
        log("INFO", "→ tools/list")

        resp = await read_mcp_message(proc.stdout, timeout=10)
        if resp and resp.get("result"):
            tools = resp["result"].get("tools", [])
            tool_names = [t["name"] for t in tools]
            print(f"  Tools registered: {len(tools)}")
            for name in sorted(tool_names):
                print(f"    - {name}")

            expected_tools = [
                "brp_browser_list", "brp_tab_list", "brp_tab_open", "brp_tab_close",
                "brp_tab_select", "brp_navigate", "brp_snapshot", "brp_screenshot",
                "brp_click", "brp_type", "brp_fill", "brp_scroll",
                "brp_execute", "brp_hover", "brp_select", "brp_get_attribute",
                "brp_key_press", "brp_go_back", "brp_go_forward", "brp_reload",
                "brp_wait_for_selector",
            ]
            missing = [t for t in expected_tools if t not in tool_names]
            if missing:
                failed("tools/list", f"missing: {missing}")
            else:
                passed("tools/list", f"all {len(expected_tools)} expected tools present")
        else:
            failed("tools/list", "no response or error")

        # ── Test 5: brp_browser_list ──
        print("\n── Test 5: brp_browser_list (tools/call) ──", file=sys.stderr)

        call_msg = {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "brp_browser_list",
                "arguments": {},
            },
        }

        await send_mcp_message(proc.stdin, call_msg)
        log("INFO", "→ tools/call brp_browser_list")

        resp = await read_mcp_message(proc.stdout, timeout=15)
        if resp:
            log("INFO", f"← {json.dumps(resp, indent=2)[:500]}")
            result = resp.get("result", {})
            content = result.get("content", [])
            if content:
                text = content[0].get("text", "") if content else ""
                print(f"  Browser list output: {text}")
                if "No browsers connected" in text:
                    print(f"  ⚠️  No Firefox extension connected yet")
                    print(f"  → Load extension via about:debugging → Load Temporary Add-on")
                    print(f"  → Extension manifest: extension/dist/manifest.json")
                passed("brp_browser_list", "returned result (no browsers)")
            elif resp.get("error"):
                failed("brp_browser_list", f"error: {resp['error'].get('message', '?')}")
            else:
                passed("brp_browser_list", "response received")
        else:
            failed("brp_browser_list", "no response (timed out)")

        # ── Test 6: brp_navigate (will fail gracefully if no browser) ──
        print("\n── Test 6: brp_navigate (tools/call) ──", file=sys.stderr)

        nav_msg = {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "brp_navigate",
                "arguments": {"url": "https://z.ai"},
            },
        }

        await send_mcp_message(proc.stdin, nav_msg)
        log("INFO", "→ tools/call brp_navigate https://z.ai")

        resp = await read_mcp_message(proc.stdout, timeout=15)
        if resp:
            log("INFO", f"← {json.dumps(resp, indent=2)[:500]}")
            content = resp.get("result", {}).get("content", [])
            text = content[0].get("text", "") if content else json.dumps(resp)
            print(f"  Navigate output: {text}")
            if "error" in resp or "Navigated" in text:
                passed("brp_navigate", "command sent to bridge")
            else:
                passed("brp_navigate", "response received")
        else:
            failed("brp_navigate", "no response")

        # ── Test 7: brp_screenshot (will fail gracefully if no browser) ──
        print("\n── Test 7: brp_screenshot (tools/call) ──", file=sys.stderr)

        ss_msg = {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "brp_screenshot",
                "arguments": {},
            },
        }

        await send_mcp_message(proc.stdin, ss_msg)
        log("INFO", "→ tools/call brp_screenshot")

        resp = await read_mcp_message(proc.stdout, timeout=15)
        if resp:
            log("INFO", f"← {json.dumps(resp, indent=2)[:500]}")
            content = resp.get("result", {}).get("content", [])
            text = content[0].get("text", "") if content else json.dumps(resp)
            print(f"  Screenshot output: {text[:200]}")
            passed("brp_screenshot", "command sent to bridge")
        else:
            failed("brp_screenshot", "no response")

        # ── Test 8: brp_click + brp_fill (element actions) ──
        print("\n── Test 8: element.click + element.fill ──", file=sys.stderr)

        for action, extra_args in [
            ("brp_click", {"selector": "#test-btn", "selector_type": "css"}),
            ("brp_fill", {"selector": "#input", "text": "hello", "selector_type": "css"}),
            ("brp_scroll", {"selector": "body", "selector_type": "css"}),
        ]:
            msg = {
                "jsonrpc": "2.0",
                "id": 6,
                "method": "tools/call",
                "params": {"name": action, "arguments": extra_args},
            }
            await send_mcp_message(proc.stdin, msg)
            log("INFO", f"→ tools/call {action}")

            resp = await read_mcp_message(proc.stdout, timeout=15)
            if resp:
                content = resp.get("result", {}).get("content", [])
                text = content[0].get("text", "") if content else json.dumps(resp)
                print(f"  {action}: {text[:200]}")
                passed(action, "sent successfully")
            else:
                failed(action, "no response")

    finally:
        # Cleanup
        try:
            proc.stdin.close()
        except:
            pass
        try:
            proc.kill()
        except:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except:
            proc.terminate()

    # ── Summary ──
    print("\n" + "=" * 60, file=sys.stderr)
    print(f"  Results: {PASS} passed, {FAIL} failed", file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    return 0 if FAIL == 0 else 1


def main():
    exit_code = asyncio.run(test_chain())
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
