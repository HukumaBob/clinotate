import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { WorkingAreaOutline } from "./WorkingAreaOutline";

describe("WorkingAreaOutline", () => {
  it("draws the outline for a crop", () => {
    render(
      <WorkingAreaOutline
        videoRef={createRef<HTMLVideoElement>()}
        crop={{ left: 10, right: 10, top: 5, bottom: 5 }}
      />,
    );
    expect(screen.getByTestId("crop-overlay-border")).toBeInTheDocument();
  });

  it.each([null, undefined])("draws nothing for %s", (crop) => {
    render(<WorkingAreaOutline videoRef={createRef<HTMLVideoElement>()} crop={crop} />);
    expect(screen.queryByTestId("crop-overlay-root")).toBeNull();
  });
});
