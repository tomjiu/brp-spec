"""Full E2E test: Bridge + simulated Extension via WebSocket.
Bridge runs WS server on :9818.
Extension simulator connects as WS client.
AI client sends requests via stdin.
"""
import subprocess
import struct
import json
import sys
import time
import socket
import threading
import hashlib
import base64

BRIDGE_PATH = r"E:\Code\ai\brp-mvp\bridge\target\release\brp-bridge.exe"
WS_PORT = 9818

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

# ── WebSocket client (simulates Firefox Extension) ──

def ws_client_connect(port):
    """Connect to Bridge WS server and perform handshake."""
    import os
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect(("127.0.0.1", port))

    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET / HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n"
        f"\r\n"
    )
    sock.send(request.encode())

    # Read handshake response
    response = sock.recv(4096).decode("utf-8")
    if "101" not in response:
        raise ValueError(f"WS handshake failed: {response[:100]}")

    return sock

def ws_client_read(sock, timeout=10):
    """Read a WebSocket frame (masked or unmasked)."""
    sock.settimeout(timeout)
    header = sock.recv(2)
    if len(header) < 2:
        return None
    opcode = header[0] & 0x0F
    masked = header[1] & 0x80
    length = header[1] & 0x7F

    if length == 126:
        length = struct.unpack("!H", sock.recv(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", sock.recv(8))[0]

    if masked:
        mask_key = sock.recv(4)
        data = bytearray(sock.recv(length))
        for i in range(len(data)):
            data[i] ^= mask_key[i % 4]
        payload = bytes(data)
    else:
        payload = sock.recv(length)

    if opcode == 0x01:
        return payload.decode("utf-8")
    elif opcode == 0x08:
        return None
    return payload

def ws_client_send(sock, text):
    """Send a WebSocket text frame (masked, client-style)."""
    import os
    data = text.encode("utf-8")
    length = len(data)
    frame = bytearray()
    frame.append(0x81)  # FIN + Text
    if length < 126:
        frame.append(0x80 | length)  # Masked
    elif length < 65536:
        frame.append(0x80 | 126)
        frame.extend(struct.pack("!H", length))
    else:
        frame.append(0x80 | 127)
        frame.extend(struct.pack("!Q", length))

    mask_key = os.urandom(4)
    frame.extend(mask_key)
    masked_data = bytearray(data)
    for i in range(len(masked_data)):
        masked_data[i] ^= mask_key[i % 4]
    frame.extend(masked_data)
    sock.send(bytes(frame))


def run_extension_simulator(bridge_started_event, results):
    """Connect to Bridge as Extension and handle forwarded requests."""
    try:
        # Wait for Bridge to start WS server
        bridge_started_event.wait(timeout=10)
        time.sleep(0.3)  # Give WS server a moment

        print("  [Ext] Connecting to Bridge WS server...")
        sock = ws_client_connect(WS_PORT)
        print("  [Ext] Connected & handshake complete")

        msg_count = 0
        while msg_count < 10:
            try:
                frame = ws_client_read(sock, timeout=10)
                if frame is None:
                    print("  [Ext] Connection closed")
                    break

                msg = json.loads(frame)
                msg_count += 1
                method = msg.get("method", "?")
                ext_id = msg.get("id")
                print(f"  [Ext] ← Request: {method} (id={ext_id})")

                # Build Extension response
                if method == "tab.list":
                    response = {
                        "jsonrpc": "2.0", "id": ext_id,
                        "result": {"tabs": [
                            {"tabId": 1, "title": "Example", "url": "https://example.com", "active": True}
                        ]}
                    }
                    # Also send a notification
                    time.sleep(0.1)
                    notif = {
                        "jsonrpc": "2.0",
                        "method": "notification/domChanged",
                        "params": {"revision": 2, "reason": "test"}
                    }
                    ws_client_send(sock, json.dumps(notif))
                    print("  [Ext] → Sent domChanged notification")

                elif method == "page.getInteractionTree":
                    response = {
                        "jsonrpc": "2.0", "id": ext_id,
                        "result": {
                            "revision": 1, "url": "https://example.com",
                            "title": "Example", "nodeCount": 3,
                            "root": {"nodeId": "node_1", "role": "main", "name": "Page"}
                        }
                    }
                elif method == "element.click":
                    response = {
                        "jsonrpc": "2.0", "id": ext_id,
                        "result": {"success": True, "matchedSelector": {"type": "css"}}
                    }
                else:
                    response = {
                        "jsonrpc": "2.0", "id": ext_id,
                        "error": {"code": -32601, "message": f"Unknown: {method}"}
                    }

                ws_client_send(sock, json.dumps(response))
                print(f"  [Ext] → Response for {method}")

            except socket.timeout:
                print("  [Ext] Read timeout")
                break
            except Exception as e:
                print(f"  [Ext] Error: {e}")
                break

        # Close
        try:
            close_frame = bytearray([0x88, 0x80]) + bytearray(4)
            sock.send(bytes(close_frame))
        except:
            pass
        sock.close()
        results["ext_msgs"] = msg_count
        print(f"  [Ext] Done ({msg_count} messages)")

    except Exception as e:
        print(f"  [Ext] Failed: {e}")
        results["ext_msgs"] = 0
        import traceback
        traceback.print_exc()


def main():
    print("=== BRP Bridge Full E2E Test ===\n")

    bridge_started = threading.Event()
    ext_results = {}

    # Start extension simulator thread
    ext_thread = threading.Thread(target=run_extension_simulator, args=(bridge_started, ext_results))
    ext_thread.daemon = True
    ext_thread.start()

    # Prepare stdin requests
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "0.1.0", "clientInfo": {"name": "e2e", "version": "0.1"},
                    "capabilities": {"features": ["interactionTree"], "actions": ["tab.list", "element.click"]}}},
        {"jsonrpc": "2.0", "id": 2, "method": "tab.list", "params": {}},
        {"jsonrpc": "2.0", "id": 3, "method": "page.getInteractionTree", "params": {}},
        {"jsonrpc": "2.0", "id": 4, "method": "element.click",
         "params": {"selector": {"type": "css", "value": "#btn"}}},
        {"jsonrpc": "2.0", "id": 5, "method": "shutdown", "params": {}},
        {"jsonrpc": "2.0", "id": 6, "method": "exit", "params": {}},
    ]

    stdin_data = b""
    for req in requests:
        stdin_data += encode_native_msg(req)

    import os
    env = os.environ.copy()
    env["BRP_WS_ADDR"] = f"127.0.0.1:{WS_PORT}"

    print(f"[1] Starting Bridge (WS port={WS_PORT})...")
    proc = subprocess.Popen(
        [BRIDGE_PATH],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env,
    )

    # Signal that Bridge is starting (WS server binds almost immediately)
    time.sleep(0.3)
    bridge_started.set()

    # Small delay to let extension connect before sending requests
    time.sleep(1.0)

    print(f"[2] Sending {len(requests)} requests via stdin...")
    proc.stdin.write(stdin_data)
    proc.stdin.flush()
    proc.stdin.close()

    try:
        proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()

    stdout_data = proc.stdout.read()
    stderr_text = proc.stderr.read().decode("utf-8", errors="replace")

    print(f"    Bridge exited: code={proc.returncode}, stdout={len(stdout_data)} bytes\n")

    # Decode responses
    print("[3] Responses:")
    buf = stdout_data
    responses = []
    while buf:
        resp, buf = decode_native_msg(buf)
        if resp is None:
            break
        responses.append(resp)

    tests = {}
    for resp in responses:
        rid = resp.get("id", "?")
        method = resp.get("method", "")

        if method and "notification" in method.lower():
            key = f"notif:{method}"
            tests[key] = True
            print(f"    📨 {method}")
            continue

        if "result" in resp:
            if rid == 1:
                tests["initialize"] = True
                r = resp["result"]
                print(f"    #{rid} initialize: ✅ session={r.get('sessionId')}")
            elif rid == 2:
                tests["tab.list"] = True
                tabs = resp["result"].get("tabs", [])
                print(f"    #{rid} tab.list: ✅ {len(tabs)} tab(s)")
            elif rid == 3:
                tests["getITree"] = True
                print(f"    #{rid} getITree: ✅ rev={resp['result'].get('revision')}")
            elif rid == 4:
                tests["click"] = True
                print(f"    #{rid} click: ✅ success={resp['result'].get('success')}")
            elif rid == 5:
                tests["shutdown"] = True
                print(f"    #{rid} shutdown: ✅")
            elif rid == 6:
                tests["exit"] = True
                print(f"    #{rid} exit: ✅")
            else:
                print(f"    #{rid}: OK → {json.dumps(resp['result'])[:80]}")
        elif "error" in resp:
            err = resp["error"]
            print(f"    #{rid}: ❌ {err.get('message')} (code={err.get('code')})")
            if rid == 2:
                tests["tab.list"] = False

    ext_thread.join(timeout=5)

    print(f"\n[4] Extension handled: {ext_results.get('ext_msgs', 0)} messages")

    # Show key log lines
    log_lines = [l for l in stderr_text.strip().split("\n") if l.strip()]
    print(f"\n[5] Bridge logs ({len(log_lines)} lines):")
    for line in log_lines[:15]:
        print(f"    {line}")

    print("\n=== Results ===")
    passed = sum(1 for v in tests.values() if v)
    total = len(tests)
    for name, ok in tests.items():
        status = "PASS" if ok else "FAIL"
        print(f"  {status}: {name}")
    print(f"\n  {passed}/{total} passed")
    return 0 if passed >= 6 else 1

if __name__ == "__main__":
    sys.exit(main())
