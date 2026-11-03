import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { QcPage } from "./QcPage";

vi.mock("../../entities/useInferenceRuns", () => ({
  useInferenceRuns: () => ({ data: [] }),
  useCreateInferenceRun: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useDeleteInferenceRun: () => ({ mutate: vi.fn(), error: null }),
}));
vi.mock("../../entities/useModelVersions", () => ({ useModelVersions: () => ({ data: [] }) }));
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

describe("QcPage reference entry point", () => {
  it("shows the Label reference link only once a video is chosen", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <QcPage />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: "Label reference" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("Video"), "9");
    expect(screen.getByRole("link", { name: "Label reference" })).toHaveAttribute("href", "/qc/reference/9");
  });
});
