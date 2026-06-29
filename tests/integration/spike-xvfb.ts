/**
 * Phase 2 xvfb Spike — verify technical feasibility
 *
 * Answers:
 * 1. Can CI install xvfb + system Firefox?
 * 2. Can xvfb-run load BRP extension?
 * 3. Does connectNative() work in xvfb Firefox (B1 auto-link)?
 *
 * This is a SPIKE — not a real test. Just verifies feasibility.
 */

import { execSync, spawn } from "child_process";
import path from "path";
import fs from "fs";

const EXTENSION_PATH = process.env.BRP_EXTENSION_PATH
  || path.resolve(__dirname, "../../extension");
const BRIDGE_BINARY = process.env.BRP_BRIDGE_PATH
  || path.resolve(__dirname, "../../bridge/target/release/brp-bridge");

async function main() {
  console.log("=== Phase 2 xvfb Spike ===\n");

  // 1. Check xvfb installed
  console.log("1. Checking xvfb...");
  try {
    execSync("which xvfb-run", { stdio: "inherit" });
    console.log("   ✅ xvfb-run available\n");
  } catch {
    console.error("   ❌ xvfb-run not found. Install with: sudo apt-get install xvfb");
    process.exit(1);
  }

  // 2. Check system Firefox
  console.log("2. Checking system Firefox...");
  try {
    const ffVersion = execSync("firefox --version", { encoding: "utf-8" }).trim();
    console.log(`   ✅ ${ffVersion}\n`);
  } catch {
    console.error("   ❌ firefox not found. Install with: sudo apt-get install firefox");
    process.exit(1);
  }

  // 3. Check extension built
  console.log("3. Checking extension dist/...");
  if (!fs.existsSync(path.join(EXTENSION_PATH, "dist", "background.js"))) {
    console.error(`   ❌ Extension not built. Run: cd extension && npm ci && npm run build`);
    process.exit(1);
  }
  console.log("   ✅ extension dist/ exists\n");

  // 4. Check bridge binary
  console.log("4. Checking bridge binary...");
  if (!fs.existsSync(BRIDGE_BINARY)) {
    console.error(`   ❌ Bridge not built. Run: cd bridge && cargo build --release`);
    process.exit(1);
  }
  console.log("   ✅ bridge binary exists\n");

  // 5. Install native messaging manifest for test
  console.log("5. Installing native messaging manifest...");
  const manifestTemplate = fs.readFileSync(
    path.resolve(__dirname, "../../native-manifest/org.brp.bridge.json"),
    "utf-8",
  );
  const manifest = manifestTemplate.replace(
    /"[^"]*PLACEHOLDER[^"]*"/,
    JSON.stringify(BRIDGE_BINARY),
  );
  const manifestDir = path.join(process.env.HOME!, ".mozilla/native-messaging-hosts");
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, "org.brp.bridge.json");
  fs.writeFileSync(manifestPath, manifest);
  console.log(`   ✅ manifest written to ${manifestPath}\n`);

  // 6. Launch Firefox with xvfb + extension, wait 10s, check bridge process
  console.log("6. Launching Firefox with xvfb + extension...");
  console.log("   (waiting 10s for B1 auto-link to start bridge)\n");

  const firefox = spawn("xvfb-run", [
    "-a",  // auto display number
    "firefox",
    "--load-extension=" + EXTENSION_PATH,
    "--no-remote",
    "--url", "about:blank",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MOZ_HEADLESS: "0" },
  });

  firefox.stdout?.on("data", (d: Buffer) => process.stdout.write(`[firefox] ${d}`));
  firefox.stderr?.on("data", (d: Buffer) => process.stderr.write(`[firefox err] ${d}`));

  // 等 10 秒给 B1 auto-link 机会
  await new Promise(r => setTimeout(r, 10000));

  // 7. Check if bridge process started
  console.log("7. Checking if bridge process started (B1 auto-link)...");
  try {
    const psOutput = execSync("ps aux | grep brp-bridge | grep -v grep", { encoding: "utf-8" });
    console.log("   ✅ Bridge process found:");
    console.log("   " + psOutput.trim().split("\n").join("\n   "));
  } catch {
    console.error("   ❌ Bridge process NOT found — connectNative failed in xvfb");
    console.error("   Possible causes:");
    console.error("   - Native messaging manifest not registered properly");
    console.error("   - Firefox doesn't support connectNative in xvfb mode");
    console.error("   - Extension failed to load");
  }

  // 8. Cleanup
  console.log("\n8. Cleanup...");
  firefox.kill("SIGTERM");
  try {
    fs.unlinkSync(manifestPath);
    console.log("   ✅ manifest removed");
  } catch {
    console.log("   ⚠️ could not remove manifest (non-fatal)");
  }

  console.log("\n=== Spike complete ===");
}

main().catch((err) => {
  console.error("Spike crashed:", err);
  process.exit(1);
});
