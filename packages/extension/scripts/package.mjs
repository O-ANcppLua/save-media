#!/usr/bin/env node
/**
 * Pack chrome + firefox + edge release zips from the already-built dist
 * directories. Run `pnpm build:all` first so dist-chrome and dist-firefox
 * exist; this script does not invoke vite itself so CI can decouple the
 * pack step from the build step and parallelise.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = readVersion();

// Edge ships the chromium build verbatim; just rename the zip so release
// pipelines can publish to the Edge add-ons catalog with the right name.
const targets = [
  { name: "chrome",  dir: "dist-chrome" },
  { name: "edge",    dir: "dist-chrome" },
  { name: "firefox", dir: "dist-firefox" },
];

for (const t of targets) {
  const src = resolve(root, t.dir);
  if (!existsSync(src)) {
    console.error(`✘ ${t.dir} missing — run pnpm build:all first`);
    process.exit(1);
  }
  const out = resolve(root, `savemedia-${t.name}-${version}.zip`);
  spawnSync("rm", ["-f", out]);
  const r = spawnSync("zip", ["-r", "-q", out, "."], { cwd: src, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`✘ zip failed for ${t.name}`);
    process.exit(r.status ?? 1);
  }
  console.log(`✓ ${out} (${(statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
}

function readVersion() {
  const pkg = JSON.parse(spawnSync("cat", [resolve(root, "package.json")]).stdout?.toString() ?? "{}");
  return pkg.version ?? "0.0.0";
}
