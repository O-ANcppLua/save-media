import type { JobError } from "../errors/taxonomy";
import type { OutputContainer } from "../types/stream";

// Unique-symbol brand: type-only, never exported.
// External code cannot name this symbol and therefore cannot construct
// a VerifiedOutput from scratch — it must go through verify().
declare const _verified: unique symbol;

export interface UnverifiedOutput {
  readonly path: string;
  readonly bytes: number;
  readonly checksum: string;
  /**
   * First few bytes of the output file. Required by container-validity
   * checks; ignored by other check kinds. 32 bytes is enough for ftyp,
   * moof, EBML, and MPEG-TS sync probes.
   */
  readonly head?: Uint8Array | undefined;
}

export interface VerifiedOutput {
  /** Brand tag — not present at runtime; enforced structurally by TypeScript. */
  readonly [_verified]: true;
  readonly path: string;
  readonly bytes: number;
  readonly checksum: string;
  readonly checks: readonly VerifyCheck[];
}

export type VerifyCheck =
  | { kind: "segment-count";      expected: number; got: number }
  | { kind: "duration";           expectedMs: number; gotMs: number; toleranceMs: number }
  | { kind: "byte-checksum";      algo: "sha256"; expected: string; got: string }
  | { kind: "container-validity"; via: "mediabunny-probe" | "mp4box-probe" | "magic-bytes"; expected: OutputContainer };

export type VerifyResult =
  | { kind: "success"; output: VerifiedOutput }
  | { kind: "failure"; error: JobError };

export async function verify(
  output: UnverifiedOutput,
  checks: readonly VerifyCheck[],
): Promise<VerifyResult> {
  for (const check of checks) {
    if (check.kind === "segment-count" && check.expected !== check.got) {
      return {
        kind: "failure",
        error: { code: "verification_segment_count", severity: "terminal", expected: check.expected, got: check.got },
      };
    }
    if (check.kind === "duration" && Math.abs(check.expectedMs - check.gotMs) > check.toleranceMs) {
      return {
        kind: "failure",
        error: { code: "verification_duration", severity: "terminal", expectedMs: check.expectedMs, gotMs: check.gotMs, toleranceMs: check.toleranceMs },
      };
    }
    if (check.kind === "byte-checksum" && check.expected !== check.got) {
      return {
        kind: "failure",
        error: { code: "verification_checksum", severity: "terminal", algo: check.algo, expected: check.expected, got: check.got },
      };
    }
    if (check.kind === "container-validity") {
      const reason = probeContainer(output.head, check.expected);
      if (reason !== null) {
        return {
          kind: "failure",
          error: { code: "verification_container", severity: "terminal", probeError: reason },
        };
      }
    }
  }

  // Cast is safe: this is the only site that produces VerifiedOutput.
  // The brand property [_verified] is type-only — no runtime overhead.
  const branded = {
    path: output.path,
    bytes: output.bytes,
    checksum: output.checksum,
    checks,
  } as VerifiedOutput;
  return { kind: "success", output: branded };
}

/**
 * Magic-byte probe — returns null on success, an error description on
 * failure. We do NOT call into mediabunny / mp4box here (the core package
 * has no DOM); the engine extension can pass via: "mp4box-probe" with
 * pre-computed metadata in a future revision.
 */
function probeContainer(head: Uint8Array | undefined, expected: OutputContainer): string | null {
  if (!head || head.length < 4) {
    return `cannot verify container ${expected}: no head bytes supplied`;
  }
  const actual = detectMagic(head);
  if (actual === null) {
    return `unknown container magic for expected ${expected}`;
  }
  if (actual !== expected) {
    return `expected ${expected} but file magic is ${actual}`;
  }
  return null;
}

function detectMagic(head: Uint8Array): OutputContainer | "mpegts" | null {
  // ISO-BMFF (MP4, fMP4, CMAF): 4-byte size + "ftyp" / "moof" at offset 4.
  if (
    head.length >= 8
    && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
  ) return "mp4";
  if (
    head.length >= 8
    && head[4] === 0x6D && head[5] === 0x6F && head[6] === 0x6F && head[7] === 0x66
  ) return "mp4";
  // EBML (Matroska / WebM): 0x1A45DFA3 at offset 0. We can't distinguish
  // WebM from MKV without scanning the DocType element — caller's expected
  // container disambiguates.
  if (head.length >= 4 && head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3) {
    return "webm";
  }
  // MPEG-TS: sync byte 0x47 at offset 0 of every 188-byte packet.
  if (head[0] === 0x47) return "mpegts";
  return null;
}
