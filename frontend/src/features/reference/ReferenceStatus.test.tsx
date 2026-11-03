import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReferenceStatus } from "./ReferenceStatus";

describe("ReferenceStatus", () => {
  it("shows the none state without a restore button", () => {
    render(<ReferenceStatus status="none" compromisedAt={null} onRestore={vi.fn()} />);
    expect(screen.getByText("No reference")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the clean state without a restore button", () => {
    render(<ReferenceStatus status="clean" compromisedAt={null} onRestore={vi.fn()} />);
    expect(screen.getByText("Clean")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the compromised state and confirms before restoring", () => {
    const onRestore = vi.fn();
    render(
      <ReferenceStatus status="compromised" compromisedAt="2026-11-01T10:00:00Z" onRestore={onRestore} />,
    );
    expect(screen.getByText("Compromised")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore clean" }));
    expect(onRestore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it("the armed restore can be cancelled", () => {
    const onRestore = vi.fn();
    render(<ReferenceStatus status="compromised" compromisedAt={null} onRestore={onRestore} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore clean" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Restore clean" })).toBeInTheDocument();
    expect(onRestore).not.toHaveBeenCalled();
  });
});
