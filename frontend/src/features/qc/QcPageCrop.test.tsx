import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { QcPage } from "./QcPage";

const mutate = vi.fn();

vi.mock("../../entities/useInferenceRuns", () => ({
  useInferenceRuns: () => ({ data: [] }),
  useCreateInferenceRun: () => ({ mutate, isPending: false, error: null }),
  useDeleteInferenceRun: () => ({ mutate: vi.fn(), error: null }),
}));
vi.mock("../../entities/useModelVersions", () => ({
  useModelVersions: () => ({
    data: [{ id: 4, name: "yolo-det", task_type: "detection", adapter: "ultralytics_yolo" }],
  }),
}));
vi.mock("../../entities/useVideos", () => ({
  useVideos: () => ({ data: [{ id: 9, title: "Colonoscopy A" }] }),
}));
vi.mock("../media/VideoUploadFlow", () => ({ VideoUploadFlow: () => null }));
vi.mock("./RunStatus", () => ({ RunStatus: () => null }));
vi.mock("./CropPicker", () => ({
  CropPicker: ({ onChange }: { onChange: (crop: unknown) => void }) => (
    <button type="button" onClick={() => onChange({ left: 10, right: 5, top: 0, bottom: 0 })}>
      mock-crop
    </button>
  ),
}));

async function fillAndRun(user: ReturnType<typeof userEvent.setup>, pickCrop: boolean) {
  render(
    <MemoryRouter>
      <QcPage />
    </MemoryRouter>,
  );
  await user.selectOptions(screen.getByLabelText("Video"), "9");
  await user.selectOptions(screen.getByLabelText("Model"), "4");
  if (pickCrop) await user.click(screen.getByRole("button", { name: "mock-crop" }));
  await user.click(screen.getByRole("button", { name: "Run" }));
}

beforeEach(() => mutate.mockReset());

describe("QcPage run body", () => {
  it("sends the working area when one was chosen", async () => {
    await fillAndRun(userEvent.setup(), true);
    expect(mutate.mock.calls[0][0]).toMatchObject({
      video_id: 9,
      model_version_id: 4,
      crop: { left: 10, right: 5, top: 0, bottom: 0 },
    });
  });

  it("omits the crop when none was chosen", async () => {
    await fillAndRun(userEvent.setup(), false);
    expect(mutate.mock.calls[0][0]).not.toHaveProperty("crop");
  });
});
