import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { components } from "../../shared/api/generated/schema";
import { DatasetsTable } from "./DatasetsTable";

type DatasetRead = components["schemas"]["DatasetRead"];
type JobRead = components["schemas"]["JobRead"];

const DATASETS: DatasetRead[] = [
  {
    id: 1,
    name: "colono-detection",
    task_type: "detection",
    taxonomy_version: 1,
    split_config: { train: 70, val: 20, test: 10 },
    grouping_overrides: {},
    excluded_label_ids: [],
    class_limits: {},
    balance_metrics: { severity: "moderate_imbalance" },
    created_at: "2026-08-16T10:00:00Z",
    item_count: 66,
    split_counts: { train: 40, val: 20, test: 6 },
    items: [],
  },
];

function renderTable(overrides: {
  onExport?: (dataset: DatasetRead) => void;
  exportJobs?: Record<number, Partial<JobRead>>;
  downloadUrls?: Record<number, string>;
} = {}) {
  render(
    <MemoryRouter>
      <DatasetsTable
        datasets={DATASETS}
        onDelete={vi.fn()}
        onShowMetrics={vi.fn()}
        onExport={overrides.onExport ?? vi.fn()}
        exportJobs={overrides.exportJobs}
        downloadUrls={overrides.downloadUrls}
      />
    </MemoryRouter>,
  );
}

describe("DatasetsTable export action", () => {
  it("starts an export when the export action is used", async () => {
    const onExport = vi.fn();
    renderTable({ onExport });

    await userEvent.click(screen.getByRole("button", { name: /export/i }));

    expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("shows progress while an export job is running", () => {
    renderTable({ exportJobs: { 1: { status: "running", progress: 42, result_ref: null } } });
    expect(screen.getByTestId("export-progress-1")).toHaveTextContent("42");
  });

  it("offers a download link when an export job has succeeded", () => {
    renderTable({
      exportJobs: { 1: { status: "succeeded", progress: 100, result_ref: "datasets/1/export-x.zip" } },
      downloadUrls: { 1: "https://minio.example.com/datasets/1/export-x.zip?X-Amz-Signature=abc" },
    });
    const link = screen.getByTestId("export-download-1");
    expect(link).toBeInTheDocument();
    // The anchor must point at the presigned URL, not the raw storage key --
    // result_ref alone is not a fetchable link.
    expect(link).toHaveAttribute(
      "href",
      "https://minio.example.com/datasets/1/export-x.zip?X-Amz-Signature=abc",
    );
  });

  it("reports a failed export instead of silently doing nothing", () => {
    renderTable({
      exportJobs: { 1: { status: "failed", progress: 0, result_ref: null, error: "3 findings; export aborted" } },
    });
    expect(screen.getByTestId("export-error-1")).toHaveTextContent(/findings/i);
  });

  it("links a failed export to the frame that broke it", () => {
    renderTable({
      exportJobs: {
        1: {
          status: "failed",
          progress: 0,
          result_ref: null,
          error: "Export aborted: unusable mask",
          payload: { findings: [{ frame_id: 15702, sequence_id: 2322, annotation_id: 10788 }] },
        },
      },
    });
    expect(screen.getByTestId("export-frame-link-1")).toHaveAttribute("href", "/sequences/2322?frame=15702");
  });

  it("shows no frame link when the failure names no frame", () => {
    renderTable({
      exportJobs: { 1: { status: "failed", progress: 0, result_ref: null, error: "boom", payload: {} } },
    });
    expect(screen.queryByTestId("export-frame-link-1")).not.toBeInTheDocument();
  });
});
