import { describe, expect, it } from "vitest";
import { detectContainerFromBytes, detectContainerFromMime } from "../../src/classifier/container-registry";

const ftyp = (brand: string) => {
  const b = new Uint8Array(16);
  b.set([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70]); // size + "ftyp"
  b.set(new TextEncoder().encode(brand), 8);
  return b;
};

describe("container-registry magic bytes", () => {
  it("detects ISO BMFF with isom brand as mp4", () => {
    expect(detectContainerFromBytes(ftyp("isom"))).toBe("mp4");
  });

  it("does not accept QuickTime as a supported direct container", () => {
    expect(detectContainerFromBytes(ftyp("qt  "))).toBe("unknown");
  });

  it("detects dash brand as fmp4", () => {
    expect(detectContainerFromBytes(ftyp("dash"))).toBe("fmp4");
  });

  it("detects EBML 0x1A45DFA3 as matroska/webm", () => {
    const b = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
    expect(detectContainerFromBytes(b)).toBe("mkv"); // DocType TBD by deeper parse
  });

  it("detects EBML WebM doctype when present in the probe window", () => {
    const b = new Uint8Array(64);
    b.set([0x1a, 0x45, 0xdf, 0xa3]);
    b.set(new TextEncoder().encode("webm"), 16);
    expect(detectContainerFromBytes(b)).toBe("webm");
  });

  it("detects MPEG-TS sync byte at offset 0 and 188", () => {
    const b = new Uint8Array(200);
    b[0] = 0x47;
    b[188] = 0x47;
    expect(detectContainerFromBytes(b)).toBe("mpegts");
  });

  it("returns unknown for empty buffer", () => {
    expect(detectContainerFromBytes(new Uint8Array(0))).toBe("unknown");
  });
});

describe("container-registry MIME", () => {
  it("video/mp4 → mp4", () => expect(detectContainerFromMime("video/mp4")).toBe("mp4"));
  it("video/webm → webm", () => expect(detectContainerFromMime("video/webm")).toBe("webm"));
  it("application/vnd.apple.mpegurl → unknown (manifest, not container)", () => {
    expect(detectContainerFromMime("application/vnd.apple.mpegurl")).toBe("unknown");
  });
  it("returns unknown for empty string", () => expect(detectContainerFromMime("")).toBe("unknown"));
});
