import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface ManifestCommand {
  readonly suggested_key?: Readonly<Record<string, string>>;
  readonly description?: string;
}

interface Manifest {
  readonly commands?: Readonly<Record<string, ManifestCommand>>;
}

describe("manifest commands", () => {
  it("registers Alt+S as the one-key best download command", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "manifest.json"), "utf8"),
    ) as Manifest;

    expect(manifest.commands?.["download-best"]).toMatchObject({
      suggested_key: {
        default: "Alt+S",
        mac: "Alt+S",
      },
    });
  });
});
