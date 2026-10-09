import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SettingsForm } from "./SettingsForm";
import { defaultValues } from "./settingsLogic";
import { settingsSchemaFixture as schema } from "./testFixtures";

function setup(overrides = {}, errors = {}) {
  const props = {
    schema,
    values: { ...defaultValues(schema), ...overrides },
    errors,
    onChange: vi.fn(),
    onReset: vi.fn(),
    onApplyPreset: vi.fn(),
  };
  render(<SettingsForm {...props} />);
  return props;
}

describe("SettingsForm", () => {
  it("shows the basic group open and the others closed", () => {
    setup();

    expect(screen.getByLabelText("Epochs")).toBeVisible();
    expect(screen.getByLabelText("Batch size")).toBeVisible();
    expect(screen.getByLabelText("Hue shift")).not.toBeVisible();

    const augmentation = screen.getByText("Augmentation").closest("details")!;
    expect(augmentation).not.toHaveAttribute("open");
    expect(screen.getByText("Basic").closest("details")).toHaveAttribute("open");
  });

  it("explains every field in a sentence next to it", () => {
    setup();

    const epochs = screen.getByTestId("field-epochs");
    expect(within(epochs).getByText(/passes over the training set/i)).toBeInTheDocument();
  });

  it("reports edits with the field key and a numeric value, and empty as null", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.clear(screen.getByLabelText("Epochs"));
    expect(props.onChange).toHaveBeenLastCalledWith("epochs", null);

  });

  it("reports typed digits as a number", async () => {
    const user = userEvent.setup();
    const props = setup({ epochs: null });

    await user.type(screen.getByLabelText("Epochs"), "7");

    expect(props.onChange).toHaveBeenLastCalledWith("epochs", 7);
  });

  it("renders choice fields as a select and reports the chosen option", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByText("Optimization"));

    await user.selectOptions(screen.getByLabelText("Optimizer"), "AdamW");

    expect(props.onChange).toHaveBeenLastCalledWith("optimizer", "AdamW");
  });

  it("marks a changed field and resets it", async () => {
    const user = userEvent.setup();
    const props = setup({ epochs: 30 });

    const epochs = screen.getByTestId("field-epochs");
    expect(within(epochs).getByLabelText("changed from default")).toBeInTheDocument();
    await user.click(within(epochs).getByRole("button", { name: /reset/i }));

    expect(props.onReset).toHaveBeenCalledWith("epochs");
    const batch = screen.getByTestId("field-batch");
    expect(within(batch).queryByLabelText("changed from default")).not.toBeInTheDocument();
  });

  it("reports a preset id when its button is pressed and shows what it does on hover", async () => {
    const user = userEvent.setup();
    const props = setup();

    const button = screen.getByRole("button", { name: "Quick check" });
    expect(button).toHaveAttribute("title", expect.stringMatching(/\S/));
    await user.click(button);

    expect(props.onApplyPreset).toHaveBeenCalledWith("quick_check");
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("shows a validation error next to its field and flags the input", () => {
    setup({ epochs: 0 }, { epochs: "Must be at least 1" });

    expect(within(screen.getByTestId("field-epochs")).getByText("Must be at least 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Epochs")).toBeInvalid();
    expect(screen.getByLabelText("Batch size")).not.toBeInvalid();
  });

  it("an empty optional field shows as empty, not as zero", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText("Fine-tuning"));

    expect(screen.getByLabelText("Freeze first layers")).toHaveValue(null);
  });

  it("says that the learning rate is ignored with the auto optimizer", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText("Optimization"));

    expect(
      within(screen.getByTestId("field-lr0")).getByText(/only used with an explicit optimizer/i),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("field-optimizer")).getByText(/ignores the learning rate/i),
    ).toBeInTheDocument();
  });
});
