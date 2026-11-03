import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CropPicker } from "./CropPicker";

const mutateAsync = vi.fn();
let sequences: { id: number; crop_box: unknown }[] = [];

vi.mock("../../entities/useVideo", () => ({
  useVideo: () => ({ data: { id: 9, stream_url: "http://example/v.mp4" } }),
}));
vi.mock("../../entities/useSequences", () => ({
  useVideoSequences: () => ({ data: sequences, isSuccess: true }),
}));
vi.mock("../../entities/useDetectCrop", () => ({
  useDetectCrop: () => ({ mutateAsync, isPending: false }),
}));

const NO_CROP = { left: 0, right: 0, top: 0, bottom: 0 };

beforeEach(() => {
  mutateAsync.mockReset();
  sequences = [];
});

describe("CropPicker", () => {
  it("shows the four fields and the overlay for a non-zero crop", () => {
    render(
      <CropPicker videoId={9} crop={{ left: 10, right: 5, top: 0, bottom: 2 }} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText("left %")).toHaveValue(10);
    expect(screen.getByTestId("crop-overlay-root")).toBeInTheDocument();
  });

  it("starts from the crop of the video's most recent sequence", async () => {
    sequences = [
      { id: 1, crop_box: { left: 1, right: 1, top: 1, bottom: 1 } },
      { id: 2, crop_box: { left: 12, right: 8, top: 0, bottom: 0 } },
    ];
    const onChange = vi.fn();
    render(<CropPicker videoId={9} crop={NO_CROP} onChange={onChange} />);
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({ left: 12, right: 8, top: 0, bottom: 0 }),
    );
  });

  it("applies the detected crop", async () => {
    const user = userEvent.setup();
    mutateAsync.mockResolvedValue({ crop: { left: 20, right: 10, top: 0, bottom: 0 } });
    const onChange = vi.fn();
    render(<CropPicker videoId={9} crop={NO_CROP} onChange={onChange} />);
    onChange.mockClear();

    await user.click(screen.getByRole("button", { name: "Detect automatically" }));

    expect(mutateAsync).toHaveBeenCalledWith(9);
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ left: 20, right: 10, top: 0, bottom: 0 }),
    );
  });

  it("says so, and leaves the value alone, when no border is found", async () => {
    const user = userEvent.setup();
    mutateAsync.mockResolvedValue({ crop: null });
    const onChange = vi.fn();
    render(<CropPicker videoId={9} crop={NO_CROP} onChange={onChange} />);
    onChange.mockClear();

    await user.click(screen.getByRole("button", { name: "Detect automatically" }));

    expect(await screen.findByText("No border found")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
