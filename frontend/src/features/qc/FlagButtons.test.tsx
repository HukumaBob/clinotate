import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FlagButtons } from "./FlagButtons";

function setup(overrides = {}) {
  const props = { disabled: false, onFlag: vi.fn(), snapNote: null, error: null, ...overrides };
  render(<FlagButtons {...props} />);
  return props;
}

describe("FlagButtons", () => {
  it("flags a false positive and a missed object", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: /false positive/i }));
    await user.click(screen.getByRole("button", { name: /missed object/i }));
    expect(props.onFlag).toHaveBeenNthCalledWith(1, "fp");
    expect(props.onFlag).toHaveBeenNthCalledWith(2, "fn");
  });

  it("announces the keys", () => {
    setup();
    expect(screen.getByRole("button", { name: /false positive/i })).toHaveAttribute("aria-keyshortcuts", "F");
    expect(screen.getByRole("button", { name: /missed object/i })).toHaveAttribute("aria-keyshortcuts", "N");
  });

  it("disables both buttons while the predictions are not ready", () => {
    setup({ disabled: true });
    expect(screen.getByRole("button", { name: /false positive/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /missed object/i })).toBeDisabled();
  });

  it("shows the snap note and an error", () => {
    setup({ snapNote: "Snapped to processed frame 3:22", error: "This frame was already sent to training" });
    expect(screen.getByText("Snapped to processed frame 3:22")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This frame was already sent to training");
  });
});
