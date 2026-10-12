import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { RunSummary } from "./RunSummary";

const epochs = { label: "Epochs", value: "30", defaultValue: "50" };

describe("RunSummary", () => {
  it("lists only the changed settings with their defaults", () => {
    render(<RunSummary changes={[epochs]} />);

    expect(screen.getByText("Epochs")).toBeInTheDocument();
    expect(screen.getByText(/30/)).toBeInTheDocument();
    expect(screen.getByText(/default 50/i)).toBeInTheDocument();
  });

  it("says when every setting is at its default", () => {
    render(<RunSummary changes={[]} />);

    expect(screen.getByText(/default settings/i)).toBeInTheDocument();
  });

  it("keeps the change list in a closed details element that opens on click", async () => {
    const user = userEvent.setup();
    render(<RunSummary changes={[epochs]} />);

    const details = screen.getByText("1 change").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(details).toContainElement(screen.getByText("Epochs"));
    await user.click(screen.getByText("1 change"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("Epochs")).toBeVisible();
  });

  it("pluralises the change count", () => {
    render(<RunSummary changes={[epochs, { label: "Batch", value: "8", defaultValue: "16" }]} />);
    expect(screen.getByText("2 changes")).toBeInTheDocument();
  });

  it("shows no details element when there are no changes", () => {
    const { container } = render(<RunSummary changes={[]} />);
    expect(container.querySelector("details")).toBeNull();
  });
});
