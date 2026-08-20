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
    await user.click(screen.getByRole("button", { name: /delete/i }));

    expect(onDownload).toHaveBeenCalledWith(4);
    expect(onDelete).toHaveBeenCalledWith(4);
  });
});
