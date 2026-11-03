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

type Span = { startMs: number; endMs: number };

function Harness({
  onSeek,
  reference,
  errorSpans,
}: {
  onSeek: (ms: number) => void;
  reference?: React.ReactNode[];
  errorSpans?: Span[][];
}) {
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
        errorSpans={errorSpans}
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

  it("hatches the error spans on the model lane of their axis only", () => {
    render(<Harness onSeek={() => {}} errorSpans={[[{ startMs: 200, endMs: 300 }, { startMs: 900, endMs: 1200 }], []]} />);
    const anatomy = screen.getByRole("group", { name: "Anatomy" });
    const track = within(anatomy).getByTestId("lane-track");
    const first = within(track).getByTestId("error-span-0-0");
    expect(first.style.left).toBe("20%");
    expect(first.style.width).toBe("10%");
    expect(first.style.backgroundImage).toContain("repeating-linear-gradient");
    expect(first.className).toContain("pointer-events-none");
    // Clamped to the end of the lane.
    const second = within(track).getByTestId("error-span-0-1");
    expect(second.style.left).toBe("90%");
    expect(second.style.width).toBe("10%");
    // Under the blip ticks: drawn before them.
    const tick = within(track).getByTestId("blip-tick");
    expect(first.compareDocumentPosition(tick) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const mode = screen.getByRole("group", { name: "Mode" });
    expect(within(mode).queryByTestId(/^error-span-/)).toBeNull();
  });

  it("draws no hatching without error spans", () => {
    render(<Harness onSeek={() => {}} />);
    expect(screen.queryByTestId(/^error-span-/)).toBeNull();
  });

  it("does not recompute the hatching on a playhead tick", async () => {
    const spans: Span[] = [{ startMs: 200, endMs: 300 }];
    const mapSpy = vi.fn(Array.prototype.map);
    Object.defineProperty(spans, "map", { value: mapSpy });
    const errorSpans = [spans, []];
    const { container } = render(<Harness onSeek={() => {}} errorSpans={errorSpans} />);
    const calls = mapSpy.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const playheads = () =>
      [...container.querySelectorAll<HTMLElement>("[data-testid='lane-track'] > .bg-blue-400")];
    expect(playheads()[0].style.left).toBe("0%");
    container.querySelector("video")!.currentTime = 0.5;
    await vi.waitFor(() => expect(playheads()[0].style.left).toBe("50%"));
    expect(mapSpy.mock.calls.length).toBe(calls);
  });
});
