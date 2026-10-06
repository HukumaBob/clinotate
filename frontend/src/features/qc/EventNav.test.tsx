import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EventNav } from "./EventNav";

describe("EventNav", () => {
  it("disables both buttons and explains when there are no events", () => {
    render(<EventNav count={0} onPrev={vi.fn()} onNext={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Previous event" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next event" })).toBeDisabled();
    expect(screen.getByText("No flicker events at these settings")).toBeInTheDocument();
  });

  it("calls the matching handler when there are events", async () => {
    const user = userEvent.setup();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(<EventNav count={3} onPrev={onPrev} onNext={onNext} />);
    await user.click(screen.getByRole("button", { name: "Previous event" }));
    await user.click(screen.getByRole("button", { name: "Next event" }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/No flicker events/)).not.toBeInTheDocument();
  });

  it("mentions the keys", () => {
    render(<EventNav count={3} onPrev={vi.fn()} onNext={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Previous event" })).toHaveAttribute("title", "Previous event ([)");
    expect(screen.getByRole("button", { name: "Next event" })).toHaveAttribute("title", "Next event (])");
  });
});
