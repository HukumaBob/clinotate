import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CommitDialog } from "./CommitDialog";

function setup(overrides = {}) {
  const props = {
    fpCount: 2,
    fnCount: 3,
    defaultName: "QC · Colonoscopy A · run #7 · 2026-10-07",
    error: null as string | null,
    submitting: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<CommitDialog {...props} />);
  return props;
}

describe("CommitDialog", () => {
  it("is a modal dialog showing the default name and the summary", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("Sequence name")).toHaveValue("QC · Colonoscopy A · run #7 · 2026-10-07");
    expect(dialog).toHaveTextContent("2 false positives will be saved as negatives");
    expect(dialog).toHaveTextContent("3 missed objects will wait for annotation");
  });

  it("warns that the video stops being an unbiased test", () => {
    setup();
    expect(screen.getByText(/no longer an unbiased test/i)).toBeInTheDocument();
  });

  it("confirms with the edited name", async () => {
    const user = userEvent.setup();
    const props = setup();
    const field = screen.getByLabelText("Sequence name");
    await user.clear(field);
    await user.type(field, "May negatives");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(props.onConfirm).toHaveBeenCalledWith("May negatives");
  });

  it("cannot confirm an empty name", async () => {
    const user = userEvent.setup();
    setup();
    await user.clear(screen.getByLabelText("Sequence name"));
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("cancels with the button and with Escape", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });

  it("shows an error and disables Confirm while submitting", () => {
    setup({ error: "Frames past the end of the video: [100]", submitting: true });
    expect(screen.getByRole("alert")).toHaveTextContent("Frames past the end of the video: [100]");
    expect(screen.getByRole("button", { name: /confirm|sending/i })).toBeDisabled();
  });

  it("omits a line whose count is zero", () => {
    setup({ fpCount: 0 });
    expect(screen.queryByText(/false positive/i)).not.toBeInTheDocument();
  });

  it("omits the missed-objects line when there are none", () => {
    setup({ fnCount: 0 });
    expect(screen.queryByText(/missed object/i)).not.toBeInTheDocument();
  });

  it("agrees in number for a single false positive", () => {
    setup({ fpCount: 1 });
    expect(screen.getByRole("dialog")).toHaveTextContent("1 false positive will be saved as a negative");
  });

  it("does not steal focus when the parent re-renders with a new onCancel", () => {
    const base = {
      fpCount: 1,
      fnCount: 1,
      defaultName: "n",
      error: null,
      onConfirm: vi.fn(),
    };
    const { rerender } = render(
      <CommitDialog {...base} submitting={false} onCancel={() => {}} />,
    );
    expect(screen.getByLabelText("Sequence name")).toHaveFocus();
    screen.getByRole("button", { name: "Cancel" }).focus();
    rerender(<CommitDialog {...base} submitting={true} onCancel={() => {}} />);
    expect(screen.getByLabelText("Sequence name")).not.toHaveFocus();
  });

  it("ignores Escape and disables Cancel while submitting", async () => {
    const user = userEvent.setup();
    const props = setup({ submitting: true });
    await user.keyboard("{Escape}");
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("returns focus to the opener when it closes", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const base = { fpCount: 1, fnCount: 0, defaultName: "n", error: null, submitting: false };
    const { unmount } = render(<CommitDialog {...base} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText("Sequence name")).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
