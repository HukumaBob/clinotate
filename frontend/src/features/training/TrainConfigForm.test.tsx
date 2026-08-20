import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TrainConfigForm } from "./TrainConfigForm";

const datasets = [
  { id: 1, name: "polyps-v1", exported: true },
  { id: 2, name: "polyps-v2-draft", exported: false },
];

describe("TrainConfigForm", () => {
  it("marks datasets without an export as unselectable", () => {
    render(<TrainConfigForm datasets={datasets} disabled={false} onSubmit={vi.fn()} />);

    const notExported = screen.getByRole("option", { name: /polyps-v2-draft/ });
    expect(notExported).toBeDisabled();
    expect(notExported.textContent).toMatch(/export it first/i);
  });

  it("submits the entered configuration", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TrainConfigForm datasets={datasets} disabled={false} onSubmit={onSubmit} />);

    await user.selectOptions(screen.getByLabelText(/dataset/i), "1");
    await user.clear(screen.getByLabelText(/epochs/i));
    await user.type(screen.getByLabelText(/epochs/i), "25");
    await user.clear(screen.getByLabelText(/batch/i));
    await user.type(screen.getByLabelText(/batch/i), "16");
    await user.click(screen.getByRole("button", { name: /start training/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      datasetId: 1,
      baseModel: expect.any(String),
      epochs: 25,
      batch: 16,
      imgsz: 640,
    });
  });

  it("disables the start button while a run is active", () => {
    render(<TrainConfigForm datasets={datasets} disabled onSubmit={vi.fn()} />);

    expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
  });

  it("keeps advanced settings collapsed until opened", async () => {
    const user = userEvent.setup();
    render(<TrainConfigForm datasets={datasets} disabled={false} onSubmit={vi.fn()} />);

    expect(screen.queryByLabelText(/image size/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /advanced/i }));
    expect(screen.getByLabelText(/image size/i)).toBeInTheDocument();
  });
});
