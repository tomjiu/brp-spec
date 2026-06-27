import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "browser",
  target: "firefox109",
  format: "iife",
  sourcemap: false,
  logLevel: "info",
};

await Promise.all([
  build({ ...common, entryPoints: ["src/handlers.ts"], globalName: "BRP", outfile: "dist/handlers.js" }),
  build({ ...common, entryPoints: ["src/background.ts"], outfile: "dist/background.js" }),
  build({ ...common, entryPoints: ["src/itree.ts"], outfile: "dist/itree.js" }),
  build({ ...common, entryPoints: ["src/content.ts"], outfile: "dist/content.js" }),
]);
