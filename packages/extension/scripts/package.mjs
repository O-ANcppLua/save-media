import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const target of ["chrome", "firefox"]) {
  const out = `${root}/savemedia-${target}.zip`;
  spawnSync("rm", ["-f", out]);
  const r = spawnSync("zip", ["-r", out, "."], { cwd: `${root}/dist-${target}`, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log("packaged →", out);
}
