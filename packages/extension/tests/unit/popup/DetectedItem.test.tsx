import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DetectedItem } from "../../../src/popup/components/DetectedItem";
import { directDescriptor, hlsDescriptor, dashDescriptor, drmDescriptor, clearKeyDescriptor } from "./helpers/descriptors";
import type { StreamId } from "@savemedia/core";

describe("DetectedItem — DRM/ClearKey cards", () => {
  it("renders the DRM-blocked card with reason", () => {
    const { container } = render(<ul>{<DetectedItem descriptor={drmDescriptor("cdm_required")} />}</ul>);
    const card = container.querySelector('[data-testid="drm-card"]');
    expect(card).toBeTruthy();
    expect(card?.getAttribute("data-deferred")).toBe("false");
    expect(screen.getByText(/savemedia cannot decrypt this stream/i)).toBeTruthy();
    expect(screen.getByText("cdm_required")).toBeTruthy();
  });

  it("renders the ClearKey deferred card distinctly", () => {
    const { container } = render(<ul>{<DetectedItem descriptor={clearKeyDescriptor()} />}</ul>);
    const card = container.querySelector('[data-testid="drm-card"]');
    expect(card?.getAttribute("data-deferred")).toBe("true");
    expect(screen.getByText(/ClearKey \/ CENC decryption is not implemented/i)).toBeTruthy();
    expect(screen.getByText("clearkey_deferred")).toBeTruthy();
  });

  it("does not render a download button on DRM cards", () => {
    render(<ul>{<DetectedItem descriptor={drmDescriptor("cdm_required")} />}</ul>);
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
  });
});

describe("DetectedItem — direct stream card", () => {
  it("shows direct as output action when expanded", () => {
    render(<ul>{<DetectedItem descriptor={directDescriptor()} />}</ul>);
    const toggle = screen.getByRole("button", { name: /clip name/i });
    fireEvent.click(toggle);
    expect(screen.getByText("direct")).toBeTruthy();
  });

  it("sends a download message with sanitized filename when clicked", () => {
    const d = directDescriptor({ title: "My Clip / Bad!! Name" });
    render(<ul>{<DetectedItem descriptor={d} />}</ul>);
    const dl = screen.getByRole("button", { name: /download/i });
    fireEvent.click(dl);
    expect(globalThis.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls[0]?.[0] as unknown as { choice: { filename: string } };
    expect(arg.choice.filename).toBe("My Clip Bad_ Name.mp4");
  });
});

describe("DetectedItem — HLS card output action label", () => {
  it("shows 'hls' as the output action for HLS streams", () => {
    const { container } = render(<ul>{<DetectedItem descriptor={hlsDescriptor()} />}</ul>);
    fireEvent.click(container.querySelector("button")!);
    const rows = container.querySelectorAll("code");
    const labels = Array.from(rows).map(c => c.textContent);
    expect(labels).toContain("hls");
  });
});

describe("DetectedItem — unsupported stream card", () => {
  it("renders DASH as an explicit refusal with no download button", () => {
    render(<ul>{<DetectedItem descriptor={dashDescriptor()} />}</ul>);
    expect(screen.getByTestId("unsupported-card").textContent).toMatch(/DASH detected/i);
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
  });
});

describe("DetectedItem — progress + error + complete states", () => {
  it("shows active progress bar with phase + bytes", () => {
    render(
      <ul>
        <DetectedItem
          descriptor={directDescriptor()}
          status={{ phase: "active", bytesWritten: 5_000, bytesTotal: 10_000, stage: "fetching" }}
        />
      </ul>,
    );
    expect(screen.getByTestId("progress")).toBeTruthy();
    expect(screen.getByText("fetching")).toBeTruthy();
  });

  it("renders failure with userMessage when failed", () => {
    render(
      <ul>
        <DetectedItem
          descriptor={directDescriptor()}
          status={{ phase: "failed", error: { code: "manifest_404", severity: "terminal", url: "https://x/m", httpStatus: 404 } }}
        />
      </ul>,
    );
    expect(screen.getByTestId("job-error")).toBeTruthy();
    expect(screen.getByText(/manifest unavailable/i)).toBeTruthy();
  });

  it("renders HLS runtime refusal messages after a failed attempt", () => {
    render(
      <ul>
        <DetectedItem
          descriptor={hlsDescriptor()}
          status={{ phase: "failed", error: { code: "hls_live_unsupported", severity: "terminal", manifestUrl: "https://x/live.m3u8" } }}
        />
      </ul>,
    );
    expect(screen.getByTestId("job-error")).toBeTruthy();
    expect(screen.getByText(/Live HLS is not supported/i)).toBeTruthy();
  });

  it("renders complete checkmark when complete", () => {
    render(
      <ul>
        <DetectedItem descriptor={directDescriptor()} status={{ phase: "complete" }} />
      </ul>,
    );
    expect(screen.getByTestId("job-complete")).toBeTruthy();
  });

  it("calls onCancel when cancel button is clicked while active", () => {
    const onCancel = vi.fn();
    const d = directDescriptor();
    render(
      <ul>
        <DetectedItem
          descriptor={d}
          status={{ phase: "active", bytesWritten: 1, bytesTotal: 2 }}
          onCancel={onCancel}
        />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledWith(d.id);
  });
});

describe("DetectedItem — sub-720p source warning", () => {
  it("marks card with the below-720p warning when all variants are sub-720p", () => {
    const d = hlsDescriptor();
    const lowVariant = { ...d.variants[0]!, height: 360, width: 640 };
    const low = { ...d, variants: [lowVariant], id: "stream-low" as StreamId };
    render(<ul>{<DetectedItem descriptor={low} />}</ul>);
    expect(screen.getByText(/source below 720p/i)).toBeTruthy();
  });
});
