import { fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AxisLanes } from "./AxisLanes";
import { buildAxisIndexes } from "./axisIndex";
import { findBlips, mergeBlips } from "./blips";
import { makeDoc } from "./testDoc";

const doc = makeDoc();
const indexes = buildAxisIndexes(doc);
const blips = mergeBlips(indexes.map((index, axis) => findBlips(index, axis, 2)));

function Harness({ onSeek, reference }: { onSeek: (ms: number) => void; reference?: React.ReactNode[] }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  return (
    <>
      <video ref={videoRef} />
      <AxisLanes
        videoRef={videoRef}
        axes={doc.axes}
        indexes={indexes}
        durationMs={1000}
        blips={blips}
        onSeek={onSeek}
        reference={reference}
      />
    </>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("AxisLanes", () => {
  it("renders one lane per axis with a segment per run of one label", () => {
    render(<Harness onSeek={() => {}} />);
    const anatomy = screen.getByRole("group", { name: "Anatomy" });
    const mode = screen.getByRole("group", { name: "Mode" });
    // caecum, ascending, caecum, transverse
    expect(within(anatomy).getAllByTestId("segment")).toHaveLength(4);
    // white, NBI, white
    expect(within(mode).getAllByTestId("segment")).toHaveLength(3);
  });

  it("draws a blip tick per blip on its own axis", () => {
    render(<Harness onSeek={() => {}} />);
    expect(within(screen.getByRole("group", { name: "Anatomy" })).getAllByTestId("blip-tick")).toHaveLength(1);
    expect(within(screen.getByRole("group", { name: "Mode" })).getAllByTestId("blip-tick")).toHaveLength(1);
  });

  it("shows the number of label changes and the time share of each class", () => {
    render(<Harness onSeek={() => {}} />);
    const anatomy = screen.getByRole("group", { name: "Anatomy" });
    expect(within(anatomy).getByText("3 changes")).toBeInTheDocument();
    // caecum 0-200 and 300-500 of 1000 ms; ascending 200-300; transverse 500-1000.
    expect(within(anatomy).getByText("caecum 40%")).toBeInTheDocument();
    expect(within(anatomy).getByText("ascending 10%")).toBeInTheDocument();
    expect(within(anatomy).getByText("transverse 50%")).toBeInTheDocument();
    const mode = screen.getByRole("group", { name: "Mode" });
    expect(within(mode).getByText("2 changes")).toBeInTheDocument();
    expect(within(mode).getByText("NBI 10%")).toBeInTheDocument();
  });

  it("seeks to the clicked time", () => {
    const onSeek = vi.fn();
    render(<Harness onSeek={onSeek} />);
    const track = within(screen.getByRole("group", { name: "Mode" })).getByTestId("lane-track");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      left: 100, width: 400, top: 0, right: 500, bottom: 10, height: 10, x: 100, y: 0, toJSON: () => ({}),
    });
    fireEvent.click(track, { clientX: 200 });
    expect(onSeek).toHaveBeenCalledWith(250);
  });

  it("puts a reference lane above the model lane of its axis only", () => {
    render(<Harness onSeek={() => {}} reference={[<div key="r" data-testid="ref-node" />, null]} />);
    const anatomy = screen.getByRole("group", { name: "Anatomy" });
    const refNode = within(anatomy).getByTestId("ref-node");
    const track = within(anatomy).getByTestId("lane-track");
    expect(refNode.compareDocumentPosition(track) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(anatomy).getByText("reference")).toBeInTheDocument();
    expect(within(anatomy).getByText("model")).toBeInTheDocument();
    const mode = screen.getByRole("group", { name: "Mode" });
    expect(within(mode).queryByTestId("ref-node")).toBeNull();
    expect(within(mode).queryByText("reference")).toBeNull();
  });
});
