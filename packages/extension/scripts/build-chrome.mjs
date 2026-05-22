import { mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "dist-build");
const out = resolve(root, "dist-chrome");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

if (existsSync(src)) await cp(src, out, { recursive: true });

const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf-8"));
await writeFile(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("chrome build →", out);
