import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { InferenceRun } from "../../entities/useInferenceRuns";
import { RunsTable } from "./RunsTable";

const run = (over: Partial<InferenceRun>): InferenceRun => ({
  id: 1,
  video_id: 9,
  model_version_id: 4,
  model_name: "yolo11n-run7",
  job_id: 3,
  frame_stride: 5,
  status: "succeeded",
  frames_total: 10,
  frames_processed: 10,
  error: null,
  created_at: "2026-10-06T10:00:00Z",
  started_at: null,
  finished_at: null,
  ...over,
});

function renderTable(runs: InferenceRun[], onDelete = vi.fn()) {
  render(
    <MemoryRouter>
      <RunsTable runs={runs} videoTitles={{ 9: "Colonoscopy A" }} onDelete={onDelete} />
    </MemoryRouter>,
  );
  return onDelete;
}

describe("RunsTable", () => {
  it("shows the video title and the model name copied onto the run", () => {
    renderTable([run({ model_version_id: null })]);
    expect(screen.getByText("Colonoscopy A")).toBeInTheDocument();
    expect(screen.getByText("yolo11n-run7")).toBeInTheDocument();
  });

  it("links a succeeded run to its view", () => {
    renderTable([run({ id: 12 })]);
    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute("href", "/qc/12");
  });

  it("does not offer View for a run that has not succeeded", () => {
    renderTable([run({ status: "running" })]);
    expect(screen.queryByRole("link", { name: "View" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View" })).toBeDisabled();
  });

  it("offers Force delete on an active run and forwards force=true after Confirm", async () => {
    const user = userEvent.setup();
    const onDelete = renderTable([run({ id: 7, status: "running" })]);
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Force delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onDelete).toHaveBeenCalledWith(7, true);
  });

  it("deletes a finished run only after the second press, without force", async () => {
    const user = userEvent.setup();
    const onDelete = renderTable([run({ id: 12 })]);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onDelete).toHaveBeenCalledWith(12, false);
  });

  it("shows a failed run's error under its status", () => {
    renderTable([run({ status: "failed", error: "Could not open the video file" })]);
    expect(screen.getByText("Could not open the video file")).toHaveAttribute(
      "title",
      "Could not open the video file",
    );
  });

  it("shows no error line for a succeeded run", () => {
    renderTable([run({ status: "succeeded", error: null })]);
    expect(screen.queryByTitle(/./)).not.toBeInTheDocument();
  });

  it("shows an empty state", () => {
    renderTable([]);
    expect(screen.getByText(/no runs yet/i)).toBeInTheDocument();
  });
});
