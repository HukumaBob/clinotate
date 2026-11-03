import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";

import { AxisBadges } from "./AxisBadges";
import { buildAxisIndexes } from "./axisIndex";
import { makeDoc } from "./testDoc";

const doc = makeDoc();
const indexes = buildAxisIndexes(doc);

function Harness() {
  const videoRef = useRef<HTMLVideoElement>(null);
  return (
    <>
      <video ref={videoRef} data-testid="video" />
      <AxisBadges videoRef={videoRef} indexes={indexes} axes={doc.axes} />
    </>
  );
}

async function nextFrame() {
  await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
}

describe("AxisBadges", () => {
  it("shows one chip per axis with the label and confidence at the current time", async () => {
    render(<Harness />);
    await nextFrame();
    expect(await screen.findByText("caecum 91%")).toBeInTheDocument();
    expect(screen.getByText("white light 99%")).toBeInTheDocument();
    expect(screen.getByText("caecum 91%").closest("[title]")).toHaveAttribute("title", "Anatomy: caecum 91%");
  });

  it("follows the video time", async () => {
    render(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    video.currentTime = 0.25;
    await nextFrame();
    await nextFrame();
    expect(await screen.findByText("ascending 80%")).toBeInTheDocument();
  });

  it("hides chips before the first processed frame", async () => {
    const late = buildAxisIndexes(makeDoc()).map((index) => ({
      ...index,
      timestamps: index.timestamps.map((t) => t + 5000),
    }));
    function Late() {
      const videoRef = useRef<HTMLVideoElement>(null);
      return (
        <>
          <video ref={videoRef} />
          <AxisBadges videoRef={videoRef} indexes={late} axes={doc.axes} />
        </>
      );
    }
    render(<Late />);
    await nextFrame();
    expect(screen.queryByText(/%$/)).toBeNull();
  });
});
