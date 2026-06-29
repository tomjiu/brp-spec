/**
 * Copy ts-rs generated types from bridge/bindings/ to extension/src/generated/.
 * Run as: node scripts/copy-generated-types.mjs
 */
import { copyFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "..", "..", "bridge", "bindings");
const destDir = join(__dirname, "..", "src", "generated");

if (!existsSync(srcDir)) {
  console.warn("bridge/bindings/ not found — skipping type copy (run cargo test first)");
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });

const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
for (const file of files) {
  copyFileSync(join(srcDir, file), join(destDir, file));
}

console.log(`Copied ${files.length} generated type(s) to src/generated/`);
