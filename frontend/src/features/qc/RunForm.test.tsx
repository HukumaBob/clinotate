import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RunForm } from "./RunForm";

const models = [
  { id: 4, name: "yolo11n-run7", task_type: "detection" },
  { id: 5, name: "yolo11n-seg-run8", task_type: "segmentation" },
];
const videos = [{ id: 9, title: "Colonoscopy A" }];

function setup(overrides = {}) {
  const props = {
    models,
    videos,
    videoId: null as number | null,
    onVideoChange: vi.fn(),
    onSubmit: vi.fn(),
    submitting: false,
    error: null as string | null,
    ...overrides,
  };
  render(<RunForm {...props} />);
  return props;
}

describe("RunForm", () => {
  it("keeps Run disabled until a model and a video are chosen", async () => {
    setup();
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });

  it("submits the chosen model, video and stride", async () => {
    const user = userEvent.setup();
    const props = setup({ videoId: 9 });
    await user.selectOptions(screen.getByLabelText("Model"), "5");
    await user.clear(screen.getByLabelText("Frame stride"));
    await user.type(screen.getByLabelText("Frame stride"), "5");
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(props.onSubmit).toHaveBeenCalledWith({ modelVersionId: 5, videoId: 9, frameStride: 5 });
  });

  it("defaults the stride to 1", () => {
    setup();
    expect(screen.getByLabelText("Frame stride")).toHaveValue(1);
  });

  it("guides the user when there is no usable model", () => {
    setup({ models: [] });
    expect(screen.getByText(/train a detect or segment model first/i)).toBeInTheDocument();
  });

  it("shows a submit error", () => {
    setup({ error: "Video 9 is not browser-playable" });
    expect(screen.getByText("Video 9 is not browser-playable")).toBeInTheDocument();
  });
});
