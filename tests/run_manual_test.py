"""Start Bridge with fixed token, wait for extension, then test."""
import subprocess, struct, json, sys, os, time, threading

BRIDGE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "bridge", "target", "release", "brp-bridge.exe")
TOKEN = "test-token-123"

def enc(obj):
    p = json.dumps(obj).encode("utf-8")
    return struct.pack("<I", len(p)) + p

def dec(data):
    if len(data) < 4: return None, data
    l = struct.unpack("<I", data[:4])[0]
    if len(data) < 4 + l: return None, data
    return json.loads(data[4:4+l].decode("utf-8")), data[4+l:]

buf = b""
lock = threading.Lock()

def reader(proc):
    global buf
    try:
        while proc.poll() is None:
            h = proc.stdout.read(4)
            if len(h) < 4: break
            l = struct.unpack("<I", h)[0]
            p = proc.stdout.read(l)
            with lock: buf += h + p
    except: pass

def drain():
    global buf
    with lock:
        d = buf; buf = b""
    msgs = []
    while d:
        m, d = dec(d)
        if m is None: break
        msgs.append(m)
    return msgs

env = os.environ.copy()
env["BRP_AUTH_TOKEN"] = TOKEN
env["BRP_WS_ADDR"] = "127.0.0.1:9817"
env["RUST_LOG"] = "info"

print(f"Starting Bridge (token={TOKEN})...")
proc = subprocess.Popen([BRIDGE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, env=env)
t = threading.Thread(target=reader, args=(proc,), daemon=True)
t.start()
time.sleep(1)

# Drain token notification + anything else
drain()

# Initialize
proc.stdin.write(enc({"jsonrpc":"2.0","id":1,"method":"initialize",
    "params":{"protocolVersion":"0.1.0","clientInfo":{"name":"test","version":"1"},
              "capabilities":{"features":["interactionTree"],
                              "actions":["tab.list","element.click","page.getInteractionTree"]}}}))
proc.stdin.flush()
time.sleep(0.5)
drain()

print()
print("=" * 55)
print(f"  Token: {TOKEN}")
print("  1. Firefox → about:debugging → Load Temporary Add-on")
print(f"     → select: {os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'extension', 'manifest.json')}")
print("  2. Extension Options → paste token → Save")
print("  3. Open any web page (e.g. https://example.com)")
print("=" * 55)
print()
input("Press ENTER when ready...")
print()

# Test requests
for rid, method in [(10,"browser.list"),(11,"tab.list"),(12,"page.getInteractionTree")]:
    proc.stdin.write(enc({"jsonrpc":"2.0","id":rid,"method":method,"params":{}}))
    proc.stdin.flush()
    time.sleep(1.5)

time.sleep(2)
msgs = drain()

# Shutdown
proc.stdin.write(enc({"jsonrpc":"2.0","id":98,"method":"shutdown","params":{}}))
proc.stdin.write(enc({"jsonrpc":"2.0","id":99,"method":"exit","params":{}}))
proc.stdin.flush()
proc.wait(timeout=5)
stderr = proc.stderr.read().decode("utf-8",errors="replace")

print("RESULTS:")
print("-" * 55)
ok = {"browser.list":False,"tab.list":False,"getITree":False}

for m in msgs:
    rid = m.get("id")
    if m.get("method","").startswith("notification"): continue
    if "error" in m:
        print(f"  #{rid}: ERROR {m['error'].get('message','?')}")
        continue
    r = m.get("result",{})
    if rid == 10:
        bs = r.get("browsers",[])
        print(f"  browser.list: {len(bs)} browser(s)")
        ok["browser.list"] = len(bs) > 0
    elif rid == 11:
        tabs = r.get("tabs",[])
        print(f"  tab.list: {len(tabs)} tab(s)")
        for tb in tabs[:3]: print(f"    Tab {tb.get('tabId')}: {tb.get('title','?')[:50]}")
        ok["tab.list"] = len(tabs) > 0
    elif rid == 12:
        if isinstance(r, dict):
            root = r.get("root")
            nc = r.get("nodeCount",0)
            print(f"  getITree: {nc} nodes, url={r.get('url','')[:60]}")
            if root and nc > 0:
                print(f"    root: [{root.get('role')}] children={len(root.get('children',[]))}")
                print("  PASS - real ITree data")
                ok["getITree"] = True
            else:
                print(f"  WARN - dict but empty (root={root}, nodes={nc})")
        elif r is True:
            print("  getITree: FAIL - got `true` (async bug!)")
        else:
            print(f"  getITree: unexpected type {type(r).__name__}: {json.dumps(r)[:200]}")

print("-" * 55)
p = sum(ok.values())
for k,v in ok.items(): print(f"  {'PASS' if v else 'FAIL'}: {k}")
print(f"  {p}/{len(ok)} passed")

logs = [l for l in stderr.split("\n") if "Extension" in l or "AUTH" in l.upper() or "authenticated" in l.lower()]
if logs:
    print("\nLogs:")
    for l in logs[:5]: print(f"  {l.strip()}")
