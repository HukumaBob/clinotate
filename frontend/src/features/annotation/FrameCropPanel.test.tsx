import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FrameCropPanel } from "./FrameCropPanel";

const cropFrames = vi.fn();
const detectCrop = vi.fn();

vi.mock("../../entities/useFrameCrop", () => ({
  useCropFrames: () => ({ mutateAsync: cropFrames, isPending: false }),
  useDetectFramesCrop: () => ({ mutateAsync: detectCrop, isPending: false }),
}));

function setup(overrides = {}) {
  const props = {
    sequenceId: 7,
    frameIds: [1, 2, 3],
    previewUrl: "http://example/f1.png",
    hasVideo: false,
    onClose: vi.fn(),
    ...overrides,
  };
  const view = render(<FrameCropPanel {...props} />);
  return { ...props, ...view };
}

async function setLeft(user: ReturnType<typeof userEvent.setup>, value: string) {
  const field = screen.getByLabelText("left %");
  await user.clear(field);
  await user.type(field, value);
}

beforeEach(() => {
  cropFrames.mockReset();
  detectCrop.mockReset();
  cropFrames.mockResolvedValue({ frames: 3, annotations: 2, masks_clipped: 0, applied: false });
});

describe("FrameCropPanel", () => {
  it("shows the four fields, and the overlay once a crop is set", async () => {
    const user = userEvent.setup();
    setup();
    for (const side of ["left", "right", "top", "bottom"]) {
      expect(screen.getByLabelText(`${side} %`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("crop-overlay-border")).toBeNull();
    await setLeft(user, "10");
    expect(screen.getByTestId("crop-overlay-border")).toBeInTheDocument();
  });

  it("previews with a dry run and reports the counts", async () => {
    const user = userEvent.setup();
    setup();
    await setLeft(user, "25");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(cropFrames).toHaveBeenCalledWith({
      sequenceId: 7,
      frameIds: [1, 2, 3],
      crop: { left: 25, right: 0, top: 0, bottom: 0 },
      dryRun: true,
    });
    expect(await screen.findByText(/3 frames, 2 masks/)).toBeInTheDocument();
  });

  it("warns when masks reach into the area being removed", async () => {
    const user = userEvent.setup();
    cropFrames.mockResolvedValue({ frames: 3, annotations: 2, masks_clipped: 1, applied: false });
    setup();
    await setLeft(user, "25");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/1 mask has pixels in the area being removed/)).toBeInTheDocument();
  });

  it("keeps Apply disabled until a preview exists", async () => {
    const user = userEvent.setup();
    setup();
    await setLeft(user, "25");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/3 frames, 2 masks/);
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("needs a second click to apply, says it cannot be undone, then closes", async () => {
    const user = userEvent.setup();
    const props = setup();
    await setLeft(user, "25");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/3 frames, 2 masks/);
    cropFrames.mockClear();
    cropFrames.mockResolvedValue({ frames: 3, annotations: 2, masks_clipped: 0, applied: true });

    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(cropFrames).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Confirm crop of 3 frames/ }));
    expect(cropFrames).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });

  it("discards the preview when a field is edited", async () => {
    const user = userEvent.setup();
    setup();
    await setLeft(user, "25");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/3 frames, 2 masks/);
    await setLeft(user, "26");
    expect(screen.queryByText(/3 frames, 2 masks/)).toBeNull();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("discards the preview when the selection changes", async () => {
    const user = userEvent.setup();
    const props = setup();
    await setLeft(user, "25");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/3 frames, 2 masks/);
    props.rerender(<FrameCropPanel {...props} frameIds={[1, 2]} />);
    expect(screen.queryByText(/3 frames, 2 masks/)).toBeNull();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("fills the fields from the automatic proposal", async () => {
    const user = userEvent.setup();
    detectCrop.mockResolvedValue({ crop: { left: 20, right: 10, top: 1.5, bottom: 0 } });
    setup();
    await user.click(screen.getByRole("button", { name: "Detect automatically" }));
    expect(detectCrop).toHaveBeenCalledWith({ sequenceId: 7, frameIds: [1, 2, 3] });
    await waitFor(() => expect(screen.getByLabelText("left %")).toHaveValue(20));
    expect(screen.getByLabelText("right %")).toHaveValue(10);
    expect(screen.getByLabelText("top %")).toHaveValue(1.5);
  });

  it("says so, and leaves the fields alone, when no border is found", async () => {
    const user = userEvent.setup();
    detectCrop.mockResolvedValue({ crop: null });
    setup();
    await setLeft(user, "5");
    await user.click(screen.getByRole("button", { name: "Detect automatically" }));
    expect(await screen.findByText("No border found")).toBeInTheDocument();
    expect(screen.getByLabelText("left %")).toHaveValue(5);
  });

  it("notes the re-cut caveat for a sequence that has a video", () => {
    setup({ hasVideo: true });
    expect(screen.getByText(/re-cut/i)).toBeInTheDocument();
  });

  it("shows no re-cut note for a photo set", () => {
    setup({ hasVideo: false });
    expect(screen.queryByText(/re-cut/i)).toBeNull();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("shows an API error in the panel", async () => {
    const user = userEvent.setup();
    cropFrames.mockRejectedValue(new Error("These frames are used by dataset(s) d1"));
    setup();
    await setLeft(user, "25");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/used by dataset\(s\) d1/)).toBeInTheDocument();
  });
});
