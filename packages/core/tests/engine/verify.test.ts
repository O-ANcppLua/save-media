import { describe, expect, it } from "vitest";
import { verify, type UnverifiedOutput, type VerifyCheck } from "../../src/engine/verify";

const sample: UnverifiedOutput = {
  path: "/tmp/out.mp4",
  bytes: 1_000_000,
  checksum: "abc123",
};

function withHead(bytes: number[]): UnverifiedOutput {
  return { ...sample, head: new Uint8Array(bytes) };
}

const FTYP = [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0, 0, 0];
const MOOF = [0, 0, 0, 0x20, 0x6D, 0x6F, 0x6F, 0x66, 0, 0, 0, 0, 0, 0, 0, 0];
const EBML = [0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0];
const TS   = [0x47, 0x40, 0x00, 0x10];

describe("verify — value-equality checks", () => {
  it("returns success when all checks pass", async () => {
    const checks: VerifyCheck[] = [
      { kind: "segment-count", expected: 10, got: 10 },
      { kind: "byte-checksum", algo: "sha256", expected: "abc123", got: "abc123" },
    ];
    const r = await verify(sample, checks);
    expect(r.kind).toBe("success");
    if (r.kind === "success") {
      expect(r.output.path).toBe("/tmp/out.mp4");
    }
  });

  it("returns failure on segment-count mismatch", async () => {
    const r = await verify(sample, [{ kind: "segment-count", expected: 10, got: 9 }]);
    expect(r.kind).toBe("failure");
    if (r.kind === "failure") expect(r.error.code).toBe("verification_segment_count");
  });

  it("returns failure on checksum mismatch", async () => {
    const r = await verify(sample, [{ kind: "byte-checksum", algo: "sha256", expected: "abc", got: "def" }]);
    expect(r.kind).toBe("failure");
    if (r.kind === "failure") expect(r.error.code).toBe("verification_checksum");
  });
});

describe("verify — container-validity probe (magic bytes)", () => {
  it("passes when ftyp box matches expected mp4", async () => {
    const r = await verify(withHead(FTYP), [{ kind: "container-validity", via: "magic-bytes", expected: "mp4" }]);
    expect(r.kind).toBe("success");
  });

  it("passes when moof box matches expected mp4 (fragmented MP4)", async () => {
    const r = await verify(withHead(MOOF), [{ kind: "container-validity", via: "magic-bytes", expected: "mp4" }]);
    expect(r.kind).toBe("success");
  });

  it("passes when EBML header matches expected webm", async () => {
    const r = await verify(withHead(EBML), [{ kind: "container-validity", via: "magic-bytes", expected: "webm" }]);
    expect(r.kind).toBe("success");
  });

  it("fails when output claims mp4 but bytes are MPEG-TS (catches the old mis-labeled HLS output)", async () => {
    const r = await verify(withHead(TS), [{ kind: "container-validity", via: "magic-bytes", expected: "mp4" }]);
    expect(r.kind).toBe("failure");
    if (r.kind === "failure") {
      expect(r.error.code).toBe("verification_container");
      if (r.error.code === "verification_container") {
        expect(r.error.probeError).toContain("mp4");
        expect(r.error.probeError).toContain("mpegts");
      }
    }
  });

  it("fails when no head bytes were supplied", async () => {
    const r = await verify(sample, [{ kind: "container-validity", via: "magic-bytes", expected: "mp4" }]);
    expect(r.kind).toBe("failure");
    if (r.kind === "failure" && r.error.code === "verification_container") {
      expect(r.error.probeError).toContain("no head bytes");
    }
  });

  it("fails on unknown magic bytes rather than passing optimistically", async () => {
    const r = await verify(withHead([0xDE, 0xAD, 0xBE, 0xEF]), [{ kind: "container-validity", via: "magic-bytes", expected: "mp4" }]);
    expect(r.kind).toBe("failure");
    if (r.kind === "failure" && r.error.code === "verification_container") {
      expect(r.error.probeError).toContain("unknown");
    }
  });
});
