import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { JobErrorNotice } from "../src/features/annotation/JobErrorNotice";

describe("JobErrorNotice", () => {
  it("renders the message", () => {
    render(<JobErrorNotice message="SAM2 predict failed: out of memory" onDismiss={vi.fn()} />);
    expect(screen.getByText("SAM2 predict failed: out of memory")).toBeInTheDocument();
  });

  it("calls onDismiss when the dismiss button is clicked", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<JobErrorNotice message="Something broke" onDismiss={onDismiss} />);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
