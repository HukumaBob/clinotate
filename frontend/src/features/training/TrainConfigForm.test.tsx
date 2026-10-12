import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { components } from "../../shared/api/generated/schema";
import { TrainConfigForm } from "./TrainConfigForm";
import { defaultValues } from "./settingsLogic";
import { settingsSchemaFixture } from "./testFixtures";

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

const dataset = (id: number, name: string, exported: boolean) => ({
  id,
  name,
  exported,
  taskType: "detection",
  itemCount: 110,
  splitCounts: { train: 80, val: 20, test: 10 },
  classes: [{ name: "polyp", instances: 40 }],
});

const datasets = [dataset(1, "polyps-v1", true), dataset(2, "polyps-v2-draft", false)];

const prefillValues = (epochs: number) => ({ ...defaultValues(settingsSchemaFixture), epochs });

describe("TrainConfigForm", () => {
  it("is disabled until a dataset is given, and for a dataset without an export", () => {
    const { rerender } = render(
      <TrainConfigForm dataset={null} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );
    const start = () => screen.getByRole("button", { name: /start training/i });
    expect(start()).toBeDisabled();

    rerender(
      <TrainConfigForm dataset={datasets[1]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );
    expect(start()).toBeDisabled();

    rerender(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );
    expect(start()).toBeEnabled();
  });

  it("submits the dataset id of the dataset prop", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TrainConfigForm dataset={dataset(1, "x", true)} disabled={false} onSubmit={onSubmit}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );
    await user.click(screen.getByRole("button", { name: /start training/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ datasetId: 1 }));
  });

  it("applies a prefill once its base model and schema are available", () => {
    const onSubmit = vi.fn();
    render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={onSubmit}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture}
        prefill={{ nonce: 1, baseKey: "version:7", values: prefillValues(12) }} />,
    );

    expect(screen.getByLabelText(/base model/i)).toHaveValue("version:7");
    expect(screen.getByLabelText("Epochs")).toHaveValue(12);
    const summary = screen.getByText("1 change").closest("details")!;
    expect(within(summary).getByText(/Epochs/)).toBeInTheDocument();
    expect(summary.textContent).toMatch(/12/);
    expect(summary.textContent).toMatch(/default 50/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("applies a prefill that arrives before the catalog and schema as soon as both are loaded", () => {
    const prefill = { nonce: 1, baseKey: "version:7", values: prefillValues(12) };
    const props = { dataset: datasets[0], disabled: false, onSubmit: vi.fn(), prefill };
    const { rerender } = render(<TrainConfigForm {...props} />);

    rerender(<TrainConfigForm {...props} baseModels={baseModels} />);
    expect(screen.queryByLabelText("Epochs")).not.toBeInTheDocument();

    rerender(<TrainConfigForm {...props} baseModels={baseModels} settingsSchema={settingsSchemaFixture} />);
    expect(screen.getByLabelText(/base model/i)).toHaveValue("version:7");
    expect(screen.getByLabelText("Epochs")).toHaveValue(12);
  });

  it("falls back to the first pretrained model when the prefilled base is no longer offered", () => {
    render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels.slice(0, 3)} settingsSchema={settingsSchemaFixture}
        prefill={{ nonce: 1, baseKey: "version:99", values: prefillValues(12) }} />,
    );

    expect(screen.getByLabelText(/base model/i)).toHaveValue("pretrained:yolo11n.pt");
    expect(screen.getByLabelText("Epochs")).toHaveValue(12);
  });

  it("does not re-apply the same prefill nonce, so later edits survive", async () => {
    const user = userEvent.setup();
    const prefill = { nonce: 1, baseKey: "version:7", values: prefillValues(12) };
    const props = { dataset: datasets[0], disabled: false, onSubmit: vi.fn(), baseModels };
    const { rerender } = render(
      <TrainConfigForm {...props} settingsSchema={settingsSchemaFixture} prefill={prefill} />,
    );
    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "30");

    rerender(
      <TrainConfigForm {...props} settingsSchema={settingsSchemaFixture}
        baseModels={[...baseModels]} prefill={{ ...prefill }} />,
    );
    expect(screen.getByLabelText("Epochs")).toHaveValue(30);

    rerender(
      <TrainConfigForm {...props} settingsSchema={settingsSchemaFixture}
        prefill={{ ...prefill, nonce: 2 }} />,
    );
    expect(screen.getByLabelText("Epochs")).toHaveValue(12);
  });

  it("clears the name and the note, but keeps the settings, when clearTextSignal changes", async () => {
    const user = userEvent.setup();
    const props = { dataset: datasets[0], disabled: false, onSubmit: vi.fn(), baseModels,
      settingsSchema: settingsSchemaFixture };
    const { rerender } = render(<TrainConfigForm {...props} clearTextSignal={5} />);
    await user.type(screen.getByLabelText(/run name/i), "abc");
    await user.type(screen.getByLabelText(/note/i), "xyz");
    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "25");

    rerender(<TrainConfigForm {...props} clearTextSignal={5} />);
    expect(screen.getByLabelText(/run name/i)).toHaveValue("abc");

    rerender(<TrainConfigForm {...props} clearTextSignal={6} />);
    expect(screen.getByLabelText(/run name/i)).toHaveValue("");
    expect(screen.getByLabelText(/note/i)).toHaveValue("");
    expect(screen.getByLabelText("Epochs")).toHaveValue(25);
  });

  it("submits the dataset, base, name, note and only the changed settings", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TrainConfigForm
        dataset={datasets[0]}
        disabled={false}
        onSubmit={onSubmit}
        baseModels={baseModels}
        settingsSchema={settingsSchemaFixture}
      />,
    );

    await user.type(screen.getByLabelText(/run name/i), "  big frames ");
    await user.type(screen.getByLabelText(/note/i), "try 800 px");
    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "25");
    await user.click(screen.getByRole("button", { name: /start training/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      datasetId: 1,
      baseModel: "yolo11n.pt",
      baseModelVersionId: null,
      name: "big frames",
      note: "try 800 px",
      settings: { epochs: 25 },
    });
  });

  it("a preset fills the fields and replaces earlier edits", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={onSubmit}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );

    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "99");
    await user.click(screen.getByRole("button", { name: "Quick check" }));

    expect(screen.getByLabelText("Epochs")).toHaveValue(3);
    expect(screen.getByLabelText("Batch size")).toHaveValue(4);
    await user.click(screen.getByRole("button", { name: /start training/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { epochs: 3, batch: 4 } }),
    );
  });

  it("an empty optional field is not sent", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={onSubmit}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );
    await user.click(screen.getByText("Fine-tuning"));
    await user.type(screen.getByLabelText("Freeze first layers"), "10");
    await user.clear(screen.getByLabelText("Freeze first layers"));
    await user.click(screen.getByRole("button", { name: /start training/i }));

    const sent = onSubmit.mock.calls[0][0];
    expect("freeze" in sent.settings).toBe(false);
  });

  it("blocks starting while a setting is invalid", async () => {
    const user = userEvent.setup();
    render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );

    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "0");

    expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
    expect(screen.getByText(/at least 1/i)).toBeInTheDocument();
  });

  it("resets the settings when the schema changes with the dataset's task type", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );
    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "7");

    rerender(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={{ ...settingsSchemaFixture }} />,
    );

    expect(screen.getByLabelText("Epochs")).toHaveValue(50);
  });

  it("lists the changes in the bottom bar", async () => {
    const user = userEvent.setup();
    render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );

    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "25");

    const summary = screen.getByText("1 change").closest("details")!;
    expect(within(summary).getByText("Epochs")).toBeInTheDocument();
  });

  it("does not print a 'what will run' card any more", () => {
    render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );
    expect(screen.queryByText(/what will run/i)).not.toBeInTheDocument();
    expect(screen.getByText(/default settings/i)).toBeInTheDocument();
  });

  it("keeps Start training in a sticky bottom bar beside the change counter", async () => {
    const user = userEvent.setup();
    render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );
    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "25");

    const bar = screen.getByRole("button", { name: /start training/i }).closest("div.sticky")!;
    expect(bar).toContainElement(screen.getByText("1 change"));
  });

  it("puts the presets in the left column as a labelled group", () => {
    render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );
    const presets = screen.getByRole("group", { name: "Presets" });
    expect(presets).toContainElement(screen.getByRole("button", { name: "Quick check" }));
    expect(presets.parentElement!.parentElement).toContainElement(screen.getByLabelText(/base model/i));
    expect(screen.getAllByRole("button", { name: "Quick check" })).toHaveLength(1);
  });

  it("shows the chosen version's label in the base model select", async () => {
    const user = userEvent.setup();
    render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );

    await user.selectOptions(screen.getByLabelText(/base model/i), "version:7");

    expect(screen.getByLabelText(/base model/i)).toHaveValue("version:7");
    expect(screen.getByRole("option", { name: /polyps-v1-run7/ })).toBeInTheDocument();
  });

  it("shows an error and keeps Start disabled when the settings schema failed to load", () => {
    render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchemaError="Could not load training settings." />,
    );

    expect(screen.getByText("Could not load training settings.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
  });

  it("disables the start button while a run is active", () => {
    render(<TrainConfigForm dataset={datasets[0]} disabled onSubmit={vi.fn()} />);

    expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
  });

  it("groups pretrained weights and own models, with the VRAM note on large sizes", () => {
    render(
      <TrainConfigForm
        dataset={datasets[0]}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={baseModels}
        settingsSchema={settingsSchemaFixture}
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
        dataset={datasets[0]}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={baseModels.slice(0, 3)}
        settingsSchema={settingsSchemaFixture}
      />,
    );

    expect(screen.queryByRole("group", { name: /your models/i })).not.toBeInTheDocument();
  });

  it("submits the version id, not a weights name, when a version is chosen", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TrainConfigForm
        dataset={datasets[0]}
        disabled={false}
        onSubmit={onSubmit}
        baseModels={baseModels}
        settingsSchema={settingsSchemaFixture}
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
        dataset={datasets[0]}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={baseModels}
        settingsSchema={settingsSchemaFixture}
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
        dataset={datasets[0]}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={baseModels}
        settingsSchema={settingsSchemaFixture}
      />,
    );
    await user.selectOptions(screen.getByLabelText(/base model/i), "version:7");

    // A different dataset (another task type) no longer offers version 7.
    rerender(
      <TrainConfigForm
        dataset={datasets[0]}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={[pretrained("n"), pretrained("s")]}
        settingsSchema={settingsSchemaFixture}
      />,
    );

    expect(screen.getByLabelText(/base model/i)).toHaveValue("pretrained:yolo11n.pt");
  });

  it("shows an error instead of an empty list when the catalog failed to load", () => {
    render(
      <TrainConfigForm
        dataset={datasets[0]}
        disabled={false}
        onSubmit={vi.fn()}
        baseModelsError="Could not load base models."
      />,
    );

    expect(screen.getByText("Could not load base models.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
  });

  it("opens the group with an invalid value and says how many settings need attention", async () => {
    const user = userEvent.setup();
    const schema = {
      ...settingsSchemaFixture,
      presets: [
        ...settingsSchemaFixture.presets,
        { id: "bad", label: "Bad", description: "Out of range.", values: { hsv_h: 5 } },
      ],
    };
    render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={schema} />,
    );
    expect(screen.queryByText(/need attention|needs attention/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Hue shift", { selector: "input" })).not.toBeVisible();

    await user.click(screen.getByRole("button", { name: "Bad" }));

    expect(screen.getByLabelText("Hue shift")).toBeVisible();
    expect(screen.getByText("1 setting needs attention")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
  });

  it("caps the height of the list of changes so Start stays on screen", async () => {
    const user = userEvent.setup();
    render(
      <TrainConfigForm dataset={datasets[0]} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );
    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "25");

    const list = screen.getByText("1 change").closest("details")!.querySelector("ul")!;
    expect(list.className).toContain("max-h-[40vh]");
    expect(list.className).toContain("overflow-y-auto");
  });
});
