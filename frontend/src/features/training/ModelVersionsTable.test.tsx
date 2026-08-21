import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { components } from "../../shared/api/generated/schema";
import { headlineScore, ModelVersionsTable } from "./ModelVersionsTable";

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
  it("shows a classification model's accuracy instead of a blank mAP50", () => {
    // mAP50 is a detection metric; a classifier never produces one.
    // Ultralytics reports metrics/accuracy_top1 instead, and showing a dash
    // for it would hide the only score the model actually has.
    render(
      <ModelVersionsTable
        versions={[
          {
            ...versions[0],
            task_type: "classification" as const,
            metrics: { "metrics/accuracy_top1": 0.9231, "metrics/accuracy_top5": 1 },
          },
        ]}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
        onInfo={vi.fn()}
      />,
    );

    expect(screen.getByText("0.923")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("labels the score column per task so mAP50 and accuracy are not confused", () => {
    render(
      <ModelVersionsTable
        versions={[
          {
            ...versions[0],
            task_type: "classification" as const,
            metrics: { "metrics/accuracy_top1": 0.5 },
          },
        ]}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
        onInfo={vi.fn()}
      />,
    );

    expect(screen.getByText(/top-1/i)).toBeInTheDocument();
  });

  it("shows an empty state with no versions", () => {
    render(<ModelVersionsTable versions={[]} onDownload={vi.fn()} onDelete={vi.fn()}
        onInfo={vi.fn()} />);

    expect(screen.getByText(/no trained models yet/i)).toBeInTheDocument();
  });

  it("renders the headline metric", () => {
    render(<ModelVersionsTable versions={versions} onDownload={vi.fn()} onDelete={vi.fn()}
        onInfo={vi.fn()} />);

    expect(screen.getByText("yolo11n-run7")).toBeInTheDocument();
    expect(screen.getByText("0.712")).toBeInTheDocument();
  });

  it("shows a dash when no mAP50 is recorded", () => {
    render(
      <ModelVersionsTable
        versions={[{ ...versions[0], metrics: {} }]}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
        onInfo={vi.fn()}
      />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("still renders the known-key score exactly as before (regression guard)", () => {
    expect(headlineScore("detection", { "metrics/mAP50(B)": 0.657 })).toEqual({
      label: "mAP50",
      value: "0.657",
    });
    expect(headlineScore("classification", { "metrics/accuracy_top1": 0.989 })).toEqual({
      label: "top-1",
      value: "0.989",
    });
  });

  it("falls back to the first numeric key for an unknown trainer vocabulary", () => {
    // An RT-DETR-style adapter reports ap_50, not any Ultralytics key --
    // the header must show that key's own name, never a hardcoded label.
    expect(headlineScore("detection", { ap_50: 0.71 })).toEqual({
      label: "ap_50",
      value: "0.710",
    });
  });

  it("shows a dash with no misleading label when metrics has no numeric value", () => {
    expect(headlineScore("detection", {})).toEqual({ label: "", value: "—" });
    expect(headlineScore("detection", { note: "no run yet" })).toEqual({
      label: "",
      value: "—",
    });
  });

  it("calls the action handlers with the version id", async () => {
    const user = userEvent.setup();
    const onDownload = vi.fn();
    const onDelete = vi.fn();
    render(
      <ModelVersionsTable versions={versions} onDownload={onDownload} onDelete={onDelete} onInfo={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: /download/i }));
    expect(onDownload).toHaveBeenCalledWith(4);

    await user.click(screen.getByRole("button", { name: /delete/i }));
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onDelete).toHaveBeenCalledWith(4);
  });

  it("calls onInfo with the version id", async () => {
    const onInfo = vi.fn();
    render(
      <ModelVersionsTable
        versions={[versions[0]]}
        onDownload={() => {}}
        onDelete={() => {}}
        onInfo={onInfo}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /info/i }));

    expect(onInfo).toHaveBeenCalledWith(versions[0].id);
  });

  it("arming one row's delete does not arm the others", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <ModelVersionsTable versions={twoVersions} onDownload={vi.fn()} onDelete={onDelete} onInfo={vi.fn()} />,
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
