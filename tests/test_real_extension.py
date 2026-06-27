"""
BRP Real Extension Test — verifies content.js returns actual data (not `true`).

How to use:
  1. Build the Bridge:  cd bridge && cargo build --release
  2. Run this script:   python -X utf8 tests/test_real_extension.py
  3. Follow the on-screen prompts to load the extension and configure the token
  4. The script sends real requests through Bridge → Extension → content.js

What it tests:
  - browser.list → extension connected?
  - tab.list → can list real browser tabs?
  - page.getInteractionTree → returns ITree object (not `true`)?
"""
import subprocess
import struct
import json
import sys
import os
import time
import threading

BRIDGE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "bridge", "target", "release", "brp-bridge.exe"
)

def encode_msg(obj):
    payload = json.dumps(obj).encode("utf-8")
    return struct.pack("<I", len(payload)) + payload

def decode_msg(data):
    if len(data) < 4:
        return None, data
    length = struct.unpack("<I", data[:4])[0]
    if len(data) < 4 + length:
        return None, data
    payload = data[4:4+length]
    return json.loads(payload.decode("utf-8")), data[4+length:]


class BridgeClient:
    """Manages Bridge subprocess and Native Messaging I/O."""

    def __init__(self, bridge_path):
        self.proc = None
        self.stdout_buf = b""
        self.reader_thread = None
        self._lock = threading.Lock()

    def start(self):
        env = os.environ.copy()
        env["BRP_WS_ADDR"] = "127.0.0.1:9817"
        env["RUST_LOG"] = "info"

        self.proc = subprocess.Popen(
            [bridge_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

        # Background reader for stdout
        self.reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self.reader_thread.start()

    def _read_loop(self):
        """Continuously read Native Messaging frames from Bridge stdout."""
        try:
            while self.proc and self.proc.poll() is None:
                header = self.proc.stdout.read(4)
                if len(header) < 4:
                    break
                length = struct.unpack("<I", header)[0]
                payload = self.proc.stdout.read(length)
                with self._lock:
                    self.stdout_buf += header + payload
        except Exception:
            pass

    def send(self, msg):
        """Send a Native Messaging message to Bridge stdin."""
        self.proc.stdin.write(encode_msg(msg))
        self.proc.stdin.flush()

    def wait_for_message(self, check_fn, timeout=10):
        """Wait until a captured stdout message satisfies check_fn.
        Returns the matching message, or None on timeout."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                buf = self.stdout_buf
            while buf:
                msg, buf = decode_msg(buf)
                if msg is None:
                    break
                if check_fn(msg):
                    return msg
            time.sleep(0.1)
        return None

    def drain_messages(self):
        """Return all captured messages and clear the buffer."""
        with self._lock:
            buf = self.stdout_buf
            self.stdout_buf = b""
        messages = []
        while buf:
            msg, buf = decode_msg(buf)
            if msg is None:
                break
            messages.append(msg)
        return messages

    def stop(self):
        """Send shutdown/exit and wait for Bridge to stop."""
        try:
            self.send({"jsonrpc": "2.0", "id": 998, "method": "shutdown", "params": {}})
            self.send({"jsonrpc": "2.0", "id": 999, "method": "exit", "params": {}})
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self.reader_thread.join(timeout=3)

    def get_stderr(self):
        try:
            return self.proc.stderr.read().decode("utf-8", errors="replace")
        except Exception:
            return ""


bridge_path = BRIDGE_PATH

def main():
    if not os.path.exists(bridge_path):
        print(f"Bridge not found at: {bridge_path}")
        print("Build it first:  cd bridge && cargo build --release")
        return 1

    print("=" * 60)
    print("  BRP Real Extension Test")
    print("=" * 60)
    print()

    # ── Step 1: Start Bridge ──
    client = BridgeClient(bridge_path)
    print("[1] Starting Bridge...")
    client.start()
    time.sleep(0.5)

    # ── Step 2: Read auth token ──
    print("[2] Reading auto-generated auth token...")

    def is_auth_token(msg):
        return msg.get("method") == "notification/bridge.authToken"

    token_msg = client.wait_for_message(is_auth_token, timeout=5)
    if not token_msg:
        print("    ❌ Could not read token from Bridge")
        client.stop()
        return 1

    token = token_msg.get("params", {}).get("token", "")
    token_file = token_msg.get("params", {}).get("tokenFile", "")
    print(f"    Token: {token}")
    print(f"    File:  {token_file}")

    # Send initialize so Bridge is ready for forwarding
    client.send({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "0.1.0",
            "clientInfo": {"name": "real-ext-test", "version": "1.0"},
            "capabilities": {
                "features": ["interactionTree"],
                "actions": ["tab.list", "element.click", "page.getInteractionTree"]
            }
        }
    })
    time.sleep(0.5)

    # ── Step 3: Prompt user ──
    print()
    print("=" * 60)
    print("  Setup: Load Extension & Configure Token")
    print("=" * 60)
    print()
    print("  1. Open Firefox/Zen")
    print("  2. Go to about:debugging → 'This Firefox'")
    print("  3. Click 'Load Temporary Add-on'")
    ext_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension", "manifest.json")
    print(f"     Select: {ext_dir}")
    print("  4. Right-click BRP extension icon → Options")
    print(f"  5. Paste token: {token}")
    print("     Click Save")
    print("  6. Navigate to any web page (e.g. https://example.com)")
    print()
    input("  >>> Press ENTER when extension is connected...")
    print()

    # ── Step 4: Send test requests ──
    print("[3] Sending test requests...")
    print()

    client.drain_messages()  # clear init response + any notifications

    # browser.list
    client.send({"jsonrpc": "2.0", "id": 10, "method": "browser.list", "params": {}})
    time.sleep(1)

    # tab.list
    client.send({"jsonrpc": "2.0", "id": 11, "method": "tab.list", "params": {}})
    time.sleep(1)

    # page.getInteractionTree — THE KEY TEST
    client.send({"jsonrpc": "2.0", "id": 12, "method": "page.getInteractionTree", "params": {}})
    time.sleep(3)

    # ── Step 5: Collect and verify results ──
    messages = client.drain_messages()
    client.stop()
    stderr_text = client.get_stderr()

    print()
    print("=" * 60)
    print("  Results")
    print("=" * 60)
    print()

    tests = {"browser.list": False, "tab.list": False, "getITree": False}

    for resp in messages:
        rid = resp.get("id")
        method = resp.get("method", "")
        if "notification" in method:
            continue

        if "error" in resp:
            err = resp["error"]
            print(f"  #{rid}: ❌ Error: {err.get('message', 'unknown')}")
            continue

        if "result" not in resp:
            continue

        result = resp["result"]

        if rid == 10:
            browsers = result.get("browsers", [])
            print(f"  browser.list: {len(browsers)} browser(s)")
            for b in browsers:
                print(f"    → {b.get('browserId', '?')}")
            tests["browser.list"] = len(browsers) > 0

        elif rid == 11:
            tabs = result.get("tabs", [])
            print(f"  tab.list: {len(tabs)} tab(s)")
            for t in tabs[:5]:
                print(f"    → Tab {t.get('tabId')}: {t.get('title', '?')[:60]}")
            tests["tab.list"] = len(tabs) > 0

        elif rid == 12:
            root = result.get("root") if isinstance(result, dict) else None
            node_count = result.get("nodeCount", 0) if isinstance(result, dict) else 0
            url = result.get("url", "") if isinstance(result, dict) else ""
            title = result.get("title", "") if isinstance(result, dict) else ""

            print(f"  page.getInteractionTree:")
            print(f"    URL: {url}")
            print(f"    Title: {title}")
            print(f"    Nodes: {node_count}")

            # THE KEY CHECK
            if isinstance(result, dict) and root and node_count > 0:
                print(f"    Root role: {root.get('role', '?')}")
                children = root.get("children", [])
                print(f"    Root children: {len(children)}")
                if children:
                    for c in children[:3]:
                        print(f"      [{c.get('role', '?')}] \"{c.get('name', '')[:40]}\"")
                print(f"    ✅ PASS — Got real ITree (not `true`)")
                tests["getITree"] = True
            elif result is True:
                print(f"    ❌ FAIL — Got `true` instead of ITree!")
                print(f"       This means the async/sendResponse bug is still present.")
                tests["getITree"] = False
            else:
                print(f"    ⚠️  Unexpected result: {type(result).__name__}")
                print(f"    {json.dumps(result, ensure_ascii=False)[:300]}")
                tests["getITree"] = isinstance(result, dict) and "root" in result

    # ── Summary ──
    print()
    print("=" * 60)
    passed = sum(1 for v in tests.values() if v)
    total = len(tests)
    for name, ok in tests.items():
        print(f"  {'✅ PASS' if ok else '❌ FAIL'}: {name}")
    print(f"\n  {passed}/{total} passed")
    print("=" * 60)

    if tests.get("getITree"):
        print("\n  🎉 content.js async fix verified with real extension!")
    else:
        print("\n  ⚠️  Some tests failed — check extension connection and token.")

    # Show relevant log lines
    log_lines = [l for l in stderr_text.strip().split("\n") if "Extension" in l or "authenticated" in l.lower() or "AUTH" in l]
    if log_lines:
        print("\n  Relevant Bridge logs:")
        for line in log_lines[:5]:
            print(f"    {line.strip()}")

    return 0 if passed == total else 1

if __name__ == "__main__":
    sys.exit(main())
