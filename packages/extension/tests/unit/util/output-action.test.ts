import { describe, it, expect } from "vitest";
import type { JobPlan, DispatchRefusal, OutputContainer, VariantId } from "@savemedia/core";
import { outputActionFromPlan } from "../../../src/util/output-action";

const baseMp4: OutputContainer = "mp4";
const varId = "v1" as VariantId;

describe("outputActionFromPlan", () => {
  it("maps direct plan to direct", () => {
    const p: JobPlan = { kind: "direct", url: "https://x/clip.mp4", filename: "clip.mp4" };
    expect(outputActionFromPlan(p)).toBe("direct");
  });

  it("maps hls-plain plan to hls-plain", () => {
    const p: JobPlan = {
      kind: "hls-plain",
      steps: [],
      outputContainer: baseMp4,
      outputFilename: "clip.mp4",
      variantId: varId,
      estimatedBytes: null,
    };
    expect(outputActionFromPlan(p)).toBe("hls-plain");
  });

  it("maps refusal to refused", () => {
    const r: DispatchRefusal = { kind: "refuse", reason: "cdm_required" };
    expect(outputActionFromPlan(r)).toBe("refused");
  });
});
