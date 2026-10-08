import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { components } from "../../shared/api/generated/schema";
import { TrainConfigForm } from "./TrainConfigForm";

type BaseModelOption = components["schemas"]["BaseModelOption"];

const pretrained = (size: string, note: string | null = null): BaseModelOption => ({
  kind: "pretrained",
  weights: `yolo11${size}.pt`,
  label: `yolo11${size}.pt`,
  family: "yolo11",
  size,
  note,
  model_version_id: null,
});

const baseModels: BaseModelOption[] = [
  pretrained("n"),
  pretrained("s"),
  pretrained("l", "may not fit in 8 GB"),
  {
    kind: "model_version",
    weights: null,
    label: "polyps-v1-run7",
    family: null,
    size: null,
    note: "mAP50 0.650 · 2026-08-20",
    model_version_id: 7,
  },
];

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
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={onSubmit}
        baseModels={baseModels}
      />,
    );

    await user.selectOptions(screen.getByLabelText(/dataset/i), "1");
    await user.clear(screen.getByLabelText(/epochs/i));
    await user.type(screen.getByLabelText(/epochs/i), "25");
    await user.clear(screen.getByLabelText(/batch/i));
    await user.type(screen.getByLabelText(/batch/i), "16");
    await user.click(screen.getByRole("button", { name: /start training/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      datasetId: 1,
      baseModel: "yolo11n.pt",
      baseModelVersionId: null,
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

  it("announces the selected dataset so the page can load its base models", async () => {
    const onDatasetChange = vi.fn();
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        onDatasetChange={onDatasetChange}
      />,
    );

    await waitFor(() => expect(onDatasetChange).toHaveBeenCalledWith(1));
  });

  it("groups pretrained weights and own models, with the VRAM note on large sizes", () => {
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={baseModels}
      />,
    );

    expect(screen.getByRole("group", { name: /pretrained/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /your models/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /yolo11l\.pt.*may not fit in 8 GB/ })).toBeEnabled();
    expect(screen.getByRole("option", { name: /yolo11n\.pt$/ })).toBeInTheDocument();
  });

  it("omits the own-models group when there are no versions", () => {
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={baseModels.slice(0, 3)}
      />,
    );

    expect(screen.queryByRole("group", { name: /your models/i })).not.toBeInTheDocument();
  });

  it("submits the version id, not a weights name, when a version is chosen", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={onSubmit}
        baseModels={baseModels}
      />,
    );

    await user.selectOptions(screen.getByLabelText(/base model/i), "version:7");
    await user.click(screen.getByRole("button", { name: /start training/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ baseModel: null, baseModelVersionId: 7 }),
    );
  });

  it("explains head re-initialisation only when a version is chosen", async () => {
    const user = userEvent.setup();
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={baseModels}
      />,
    );

    expect(screen.queryByText(/re-initialised/i)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/base model/i), "version:7");
    expect(screen.getByText(/re-initialised/i)).toBeInTheDocument();
  });

  it("falls back to the first pretrained model when the list changes under the selection", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={baseModels}
      />,
    );
    await user.selectOptions(screen.getByLabelText(/base model/i), "version:7");

    // A different dataset (another task type) no longer offers version 7.
    rerender(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={[pretrained("n"), pretrained("s")]}
      />,
    );

    expect(screen.getByLabelText(/base model/i)).toHaveValue("pretrained:yolo11n.pt");
  });

  it("shows an error instead of an empty list when the catalog failed to load", () => {
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        baseModelsError="Could not load base models."
      />,
    );

    expect(screen.getByText("Could not load base models.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
  });
});
