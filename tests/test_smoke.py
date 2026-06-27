"""Quick smoke test for BRP Bridge binary.
Sends an 'initialize' request via stdin (Native Messaging format),
reads the response from stdout, and decodes it.
"""
import subprocess
import struct
import json
import sys
import time

BRIDGE_PATH = r"E:\Code\ai\brp-mvp\bridge\target\release\brp-bridge.exe"

def encode_native_msg(obj):
    payload = json.dumps(obj).encode("utf-8")
    return struct.pack("<I", len(payload)) + payload

def decode_native_msg(data):
    if len(data) < 4:
        return None, data
    length = struct.unpack("<I", data[:4])[0]
    if len(data) < 4 + length:
        return None, data
    payload = data[4:4+length]
    return json.loads(payload.decode("utf-8")), data[4+length:]

def main():
    print("=== BRP Bridge Smoke Test ===\n")

    # Test 1: initialize request
    init_req = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "0.1.0",
            "clientInfo": {"name": "smoke-test", "version": "0.1.0"},
            "capabilities": {
                "features": ["interactionTree", "events"],
                "actions": ["page.navigate", "element.click"]
            }
        }
    }

    # Test 2: tab.list (should fail - no extension connected, but session should be ready)
    tab_req = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tab.list",
        "params": {}
    }

    # Test 3: shutdown
    shutdown_req = {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "shutdown",
        "params": {}
    }

    # Test 4: exit
    exit_req = {
        "jsonrpc": "2.0",
        "id": 4,
        "method": "exit",
        "params": {}
    }

    stdin_data = b""
    for req in [init_req, tab_req, shutdown_req, exit_req]:
        stdin_data += encode_native_msg(req)

    print(f"[1] Sending {4} requests to Bridge...")
    print(f"    Total stdin bytes: {len(stdin_data)}")

    proc = subprocess.Popen(
        [BRIDGE_PATH],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    proc.stdin.write(stdin_data)
    proc.stdin.flush()
    proc.stdin.close()

    # Wait for process to exit
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()

    stdout_data = proc.stdout.read()
    stderr_text = proc.stderr.read().decode("utf-8", errors="replace")

    print(f"    Process exited with code: {proc.returncode}")
    print(f"    Total stdout bytes: {len(stdout_data)}")

    # Decode responses
    print("\n[2] Decoding responses...")
    buf = stdout_data
    responses = []
    while buf:
        resp, buf = decode_native_msg(buf)
        if resp is None:
            break
        responses.append(resp)

    for i, resp in enumerate(responses):
        method = resp.get("method", "")
        rid = resp.get("id", "?")
        if "result" in resp:
            print(f"    Response #{i+1} (id={rid}): OK")
            if rid == 1:
                r = resp["result"]
                print(f"      sessionId: {r.get('sessionId', '?')}")
                print(f"      protocolVersion: {r.get('protocolVersion', '?')}")
                caps = r.get("capabilities", {})
                print(f"      features: {caps.get('features', [])}")
                print(f"      actions: {caps.get('actions', [])}")
            elif rid == 2:
                print(f"      result: {json.dumps(resp['result'], ensure_ascii=False)[:200]}")
                if "error" in resp.get("result", {}):
                    print(f"      (Expected: no extension connected)")
        elif "error" in resp:
            err = resp["error"]
            print(f"    Response #{i+1} (id={rid}): ERROR")
            print(f"      code={err.get('code')} message={err.get('message')}")
            if err.get("data"):
                print(f"      data: {json.dumps(err['data'], ensure_ascii=False)[:200]}")
        elif method:
            print(f"    Notification #{i+1}: {method}")

    # Show stderr (logs)
    if stderr_text.strip():
        lines = stderr_text.strip().split("\n")
        print(f"\n[3] Bridge logs ({len(lines)} lines):")
        for line in lines:
            print(f"    {line}")

    # Summary
    print("\n=== Results ===")
    expected = 4  # initialize, tab.list (error), shutdown, exit
    got = len(responses)
    status = "PASS" if got >= 3 else "FAIL"
    print(f"  Expected ~{expected} responses, got {got} → {status}")

    if got >= 1 and "result" in responses[0]:
        print("  Initialize: PASS")
    else:
        print("  Initialize: FAIL")

    if got >= 2:
        r2 = responses[1]
        if "error" in r2:
            print("  tab.list (no ext): PASS (expected error)")
        elif "result" in r2:
            print("  tab.list: OK (got result)")

    return 0 if status == "PASS" else 1

if __name__ == "__main__":
    sys.exit(main())
