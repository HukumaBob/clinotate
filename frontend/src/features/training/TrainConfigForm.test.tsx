import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TrainConfigForm } from "./TrainConfigForm";

const datasets = [
  { id: 1, name: "polyps-v1", exported: true },
  { id: 2, name: "polyps-v2-draft", exported: false },
];

describe("TrainConfigForm", () => {
  it("preselects the first exported dataset once datasets arrive after mount", async () => {
    // The datasets prop starts empty on every real page load: TrainPage
    // renders this form immediately and fills `datasets` only when the
    // async /datasets fetch resolves. A useState initializer runs once, so
    // a default computed at mount would stay empty forever and force the
    // user to pick a dataset by hand on every visit.
    const { rerender } = render(
      <TrainConfigForm datasets={[]} disabled={false} onSubmit={vi.fn()} />,
    );

    rerender(<TrainConfigForm datasets={datasets} disabled={false} onSubmit={vi.fn()} />);

    expect(await screen.findByLabelText(/dataset/i)).toHaveValue("1");
  });

  it("keeps a manual choice when the datasets list is refreshed", async () => {
    const user = userEvent.setup();
    const withTwoExported = [...datasets, { id: 3, name: "second", exported: true }];
    const { rerender } = render(
      <TrainConfigForm datasets={withTwoExported} disabled={false} onSubmit={vi.fn()} />,
    );

    await user.selectOptions(screen.getByLabelText(/dataset/i), "3");
    rerender(<TrainConfigForm datasets={withTwoExported} disabled={false} onSubmit={vi.fn()} />);

    expect(screen.getByLabelText(/dataset/i)).toHaveValue("3");
  });

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
