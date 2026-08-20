import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { components } from "../../shared/api/generated/schema";
import { ModelVersionsTable } from "./ModelVersionsTable";

type ModelVersionRead = components["schemas"]["ModelVersionRead"];

const versions: ModelVersionRead[] = [
  {
    id: 4,
    training_run_id: 7,
    name: "yolo11n-run7",
    task_type: "detection",
    metrics: { "metrics/mAP50(B)": 0.712 },
    is_active: false,
    created_at: "2026-08-19T10:00:00Z",
  },
];

const twoVersions: ModelVersionRead[] = [
  ...versions,
  {
    id: 5,
    training_run_id: 8,
    name: "yolo11s-run8",
    task_type: "detection",
    metrics: { "metrics/mAP50(B)": 0.55 },
    is_active: false,
    created_at: "2026-08-19T11:00:00Z",
  },
];

describe("ModelVersionsTable", () => {
  it("shows an empty state with no versions", () => {
    render(<ModelVersionsTable versions={[]} onDownload={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByText(/no trained models yet/i)).toBeInTheDocument();
  });

  it("renders the headline metric", () => {
    render(<ModelVersionsTable versions={versions} onDownload={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByText("yolo11n-run7")).toBeInTheDocument();
    expect(screen.getByText("0.712")).toBeInTheDocument();
  });

  it("shows a dash when no mAP50 is recorded", () => {
    render(
      <ModelVersionsTable
        versions={[{ ...versions[0], metrics: {} }]}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("calls the action handlers with the version id", async () => {
    const user = userEvent.setup();
    const onDownload = vi.fn();
    const onDelete = vi.fn();
    render(
      <ModelVersionsTable versions={versions} onDownload={onDownload} onDelete={onDelete} />,
    );

    await user.click(screen.getByRole("button", { name: /download/i }));
    expect(onDownload).toHaveBeenCalledWith(4);

    await user.click(screen.getByRole("button", { name: /delete/i }));
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onDelete).toHaveBeenCalledWith(4);
  });

  it("arming one row's delete does not arm the others", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <ModelVersionsTable versions={twoVersions} onDownload={vi.fn()} onDelete={onDelete} />,
    );

    const deleteButtons = screen.getAllByRole("button", { name: /^delete$/i });
    expect(deleteButtons).toHaveLength(2);

    await user.click(deleteButtons[0]);

    expect(screen.getByRole("button", { name: /confirm/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^delete$/i })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /confirm/i }));

    expect(onDelete).toHaveBeenCalledWith(4);
    expect(onDelete).not.toHaveBeenCalledWith(5);
  });
});
