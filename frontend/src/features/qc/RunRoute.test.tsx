import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { RunRoute } from "./RunRoute";

let runState: { data?: unknown; isPending?: boolean; isError?: boolean };

vi.mock("../../entities/useInferenceRuns", () => ({
  useInferenceRun: () => runState,
}));
vi.mock("./RunViewPage", () => ({ RunViewPage: () => <p>Detection page</p> }));
let mounts = 0;
vi.mock("./classification/ClassificationRunPage", () => ({
  ClassificationRunPage: () => {
    // Counts mounts: another run must get a fresh page (and editor).
    useState(() => ++mounts);
    return <p>Classification page</p>;
  },
}));

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/qc/5"]}>
      <Routes>
        <Route path="/qc/:runId" element={<RunRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunRoute", () => {
  it("renders the classification page for a run with axes", () => {
    runState = { data: { id: 5, axes: [{ name: "Anatomy" }] }, isPending: false };
    renderRoute();
    expect(screen.getByText("Classification page")).toBeInTheDocument();
  });

  it("renders the detection page for a run without axes", () => {
    runState = { data: { id: 5, axes: null }, isPending: false };
    renderRoute();
    expect(screen.getByText("Detection page")).toBeInTheDocument();
  });

  it("leaves a run that failed to load to the detection page's error", () => {
    runState = { isPending: false, isError: true };
    renderRoute();
    expect(screen.getByText("Detection page")).toBeInTheDocument();
  });

  it("waits for the run before choosing", () => {
    runState = { isPending: true };
    renderRoute();
    expect(screen.queryByText("Detection page")).toBeNull();
    expect(screen.queryByText("Classification page")).toBeNull();
    expect(screen.getByText("Loading run…")).toBeInTheDocument();
  });
  it("remounts the classification page for another run, even of the same video", () => {
    mounts = 0;
    runState = { data: { id: 5, video_id: 9, axes: [{ name: "Anatomy" }] }, isPending: false };
    const { rerender } = renderRoute();
    rerender(
      <MemoryRouter initialEntries={["/qc/5"]}>
        <Routes>
          <Route path="/qc/:runId" element={<RunRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(mounts).toBe(1);
    runState = { data: { id: 6, video_id: 9, axes: [{ name: "Anatomy" }] }, isPending: false };
    rerender(
      <MemoryRouter initialEntries={["/qc/5"]}>
        <Routes>
          <Route path="/qc/:runId" element={<RunRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(mounts).toBe(2);
  });
});
