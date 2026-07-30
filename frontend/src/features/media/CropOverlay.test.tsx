import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { CropOverlay } from "./CropOverlay";

describe("CropOverlay", () => {
  it("renders inset bars sized to the given crop percentages", () => {
    render(<CropOverlay crop={{ left: 10, right: 20, top: 5, bottom: 15 }} />);

    const left = screen.getByTestId("crop-overlay-left");
    const right = screen.getByTestId("crop-overlay-right");
    const top = screen.getByTestId("crop-overlay-top");
    const bottom = screen.getByTestId("crop-overlay-bottom");

    expect(left).toHaveStyle({ width: "10%" });
    expect(right).toHaveStyle({ width: "20%" });
    expect(top).toHaveStyle({ height: "5%" });
    expect(bottom).toHaveStyle({ height: "15%" });
  });

  it("renders a border rectangle inset by the crop percentages on all four sides", () => {
    render(<CropOverlay crop={{ left: 10, right: 20, top: 5, bottom: 15 }} />);

    const border = screen.getByTestId("crop-overlay-border");
    expect(border).toHaveStyle({
      left: "10%",
      right: "20%",
      top: "5%",
      bottom: "15%",
    });
  });

  it("renders with all-zero insets and no border extending outside the frame", () => {
    render(<CropOverlay crop={{ left: 0, right: 0, top: 0, bottom: 0 }} />);

    const border = screen.getByTestId("crop-overlay-border");
    expect(border).toHaveStyle({ left: "0%", right: "0%", top: "0%", bottom: "0%" });
  });
});
