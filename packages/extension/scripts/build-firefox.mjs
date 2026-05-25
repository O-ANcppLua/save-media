#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = resolve(root, "dist-firefox-build");
const out = resolve(root, "dist-firefox");

const vite = spawnSync("pnpm", ["exec", "vite", "build"], {
  cwd: root,
  env: { ...process.env, SAVEMEDIA_BROWSER: "firefox" },
  stdio: "inherit",
});
if (vite.status !== 0) process.exit(vite.status ?? 1);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
if (existsSync(buildDir)) await cp(buildDir, out, { recursive: true });

const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf-8"));

if (manifest.background?.service_worker) {
  manifest.background = { scripts: [manifest.background.service_worker], type: "module" };
}

manifest.permissions = (manifest.permissions ?? []).filter(p => p !== "offscreen");

manifest.browser_specific_settings = {
  gecko: {
    id: "savemedia@ancplua.dev",
    data_collection_permissions: { required: ["none"] },
    strict_min_version: "140.0",
  },
};

await writeFile(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("firefox build →", out);
