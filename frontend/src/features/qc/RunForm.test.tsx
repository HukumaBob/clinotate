import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RunForm } from "./RunForm";

vi.mock("./CropPicker", () => ({
  CropPicker: ({ onChange }: { onChange: (crop: unknown) => void }) => (
    <button type="button" onClick={() => onChange({ left: 10, right: 5, top: 0, bottom: 0 })}>
      mock-crop
    </button>
  ),
}));

const models = [
  { id: 4, name: "yolo11n-run7", task_type: "detection" },
  { id: 5, name: "yolo11n-seg-run8", task_type: "segmentation" },
];
const classifyModels = [
  { id: 11, name: "bbps-cls", task_type: "classification" },
  { id: 12, name: "polyp-cls", task_type: "classification" },
];
const videos = [{ id: 9, title: "Colonoscopy A" }];

function setup(overrides = {}) {
  const props = {
    models,
    classifyModels,
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
    expect(props.onSubmit).toHaveBeenCalledWith({
      modelVersionId: 5,
      videoId: 9,
      frameStride: 5,
      perturbation: null,
      crop: null,
    });
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

  it("sends the chosen perturbation with its default strength", async () => {
    const user = userEvent.setup();
    const props = setup({ videoId: 9 });
    await user.selectOptions(screen.getByLabelText("Model"), "4");
    await user.selectOptions(screen.getByLabelText("Perturbation"), "blur");
    expect(screen.getByLabelText("Perturbation strength")).toHaveValue(2);
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(props.onSubmit).toHaveBeenCalledWith({
      modelVersionId: 4,
      videoId: 9,
      frameStride: 1,
      perturbation: { kind: "blur", strength: 2 },
      crop: null,
    });
  });

  it("blocks an out-of-range strength and says why", async () => {
    const user = userEvent.setup();
    setup({ videoId: 9 });
    await user.selectOptions(screen.getByLabelText("Model"), "4");
    await user.selectOptions(screen.getByLabelText("Perturbation"), "blur");
    await user.clear(screen.getByLabelText("Perturbation strength"));
    await user.type(screen.getByLabelText("Perturbation strength"), "99");
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(screen.getByText("Blur strength must be 0.5 to 20")).toBeInTheDocument();
  });

  describe("Classify mode", () => {
    async function toClassify(overrides = {}) {
      const user = userEvent.setup();
      const props = setup({ videoId: 9, ...overrides });
      await user.click(screen.getByRole("button", { name: "Classify" }));
      return { user, props };
    }

    it("has no axis and a disabled Run at first", async () => {
      await toClassify();
      expect(screen.queryByLabelText("Axis 1 model")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    });

    it("submits the classifiers payload", async () => {
      const { user, props } = await toClassify();
      await user.click(screen.getByRole("button", { name: "Add axis" }));
      await user.selectOptions(screen.getByLabelText("Axis 1 model"), "11");
      await user.type(screen.getByLabelText("Axis 1 name"), "prep");
      await user.click(screen.getByRole("button", { name: "Add axis" }));
      await user.selectOptions(screen.getByLabelText("Axis 2 model"), "12");
      await user.click(screen.getByRole("button", { name: "Run" }));
      expect(props.onSubmit).toHaveBeenCalledWith({
        classifiers: [{ modelVersionId: 11, name: "prep" }, { modelVersionId: 12 }],
        videoId: 9,
        frameStride: 1,
        perturbation: null,
        crop: null,
      });
    });

    it("does not offer a model already used on another axis", async () => {
      const { user } = await toClassify();
      await user.click(screen.getByRole("button", { name: "Add axis" }));
      await user.selectOptions(screen.getByLabelText("Axis 1 model"), "11");
      await user.click(screen.getByRole("button", { name: "Add axis" }));
      const axis2 = screen.getByLabelText("Axis 2 model");
      expect(within(axis2).getByRole("option", { name: "bbps-cls" })).toBeDisabled();
      expect(within(axis2).getByRole("option", { name: "polyp-cls" })).toBeEnabled();
    });

    it("stops adding axes when every model is used", async () => {
      const { user } = await toClassify();
      for (const [i, id] of [
        [1, "11"],
        [2, "12"],
      ] as const) {
        await user.click(screen.getByRole("button", { name: "Add axis" }));
        await user.selectOptions(screen.getByLabelText(`Axis ${i} model`), id);
      }
      expect(screen.getByRole("button", { name: "Add axis" })).toBeDisabled();
    });

    it("caps axes at six", async () => {
      const many = Array.from({ length: 8 }, (_, i) => ({
        id: 20 + i,
        name: `m${i}`,
        task_type: "classification",
      }));
      const { user } = await toClassify({ classifyModels: many });
      for (let i = 1; i <= 6; i++) {
        await user.click(screen.getByRole("button", { name: "Add axis" }));
        await user.selectOptions(screen.getByLabelText(`Axis ${i} model`), String(19 + i));
      }
      expect(screen.getByRole("button", { name: "Add axis" })).toBeDisabled();
    });

    it("keeps Run disabled while an axis has no model", async () => {
      const { user } = await toClassify();
      await user.click(screen.getByRole("button", { name: "Add axis" }));
      expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    });

    it("guides the user when there is no classification model", async () => {
      await toClassify({ classifyModels: [] });
      expect(screen.getByText("Train a classification model first.")).toBeInTheDocument();
    });
  });
});

describe("RunForm working area", () => {
  it("shows the crop picker only once a video is chosen", () => {
    setup();
    expect(screen.queryByRole("button", { name: "mock-crop" })).toBeNull();
  });

  it("submits the edited crop", async () => {
    const user = userEvent.setup();
    const props = setup({ videoId: 9 });
    await user.selectOptions(screen.getByLabelText("Model"), "4");
    await user.click(screen.getByRole("button", { name: "mock-crop" }));
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(props.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ crop: { left: 10, right: 5, top: 0, bottom: 0 } }),
    );
  });
});
