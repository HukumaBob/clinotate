import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VramGauge } from "../src/features/annotation/VramGauge";

describe("VramGauge", () => {
  it("shows a neutral 'no data yet' state when both values are null", () => {
    render(<VramGauge vramUsedBytes={null} vramTotalBytes={null} isLive={false} />);

    expect(screen.getByText(/no data yet/i)).toBeInTheDocument();
  });

  it("renders green when usage is below 60% of total", () => {
    // 4 GiB used of 8 GiB total = 50%
    render(
      <VramGauge
        vramUsedBytes={4 * 1024 ** 3}
        vramTotalBytes={8 * 1024 ** 3}
        isLive={true}
      />,
    );

    expect(screen.getByTestId("vram-gauge-dot")).toHaveClass("bg-green-500");
  });

  it("renders yellow when usage is between 60% and 85% of total", () => {
    // 6 GiB used of 8 GiB total = 75%
    render(
      <VramGauge
        vramUsedBytes={6 * 1024 ** 3}
        vramTotalBytes={8 * 1024 ** 3}
        isLive={true}
      />,
    );

    expect(screen.getByTestId("vram-gauge-dot")).toHaveClass("bg-yellow-500");
  });

  it("renders red when usage is above 85% of total", () => {
    // 7.5 GiB used of 8 GiB total = 93.75%
    render(
      <VramGauge
        vramUsedBytes={7.5 * 1024 ** 3}
        vramTotalBytes={8 * 1024 ** 3}
        isLive={true}
      />,
    );

    expect(screen.getByTestId("vram-gauge-dot")).toHaveClass("bg-red-500");
  });

  it("shows the exact GiB numbers with one decimal place", () => {
    render(
      <VramGauge
        vramUsedBytes={4 * 1024 ** 3}
        vramTotalBytes={8 * 1024 ** 3}
        isLive={true}
      />,
    );

    expect(screen.getByText("4.0 / 8.0 GiB")).toBeInTheDocument();
  });

  it("renders at reduced opacity when isLive is false and data exists", () => {
    render(
      <VramGauge
        vramUsedBytes={4 * 1024 ** 3}
        vramTotalBytes={8 * 1024 ** 3}
        isLive={false}
      />,
    );

    expect(screen.getByTestId("vram-gauge")).toHaveClass("opacity-50");
  });

  it("does not render at reduced opacity when isLive is true", () => {
    render(
      <VramGauge
        vramUsedBytes={4 * 1024 ** 3}
        vramTotalBytes={8 * 1024 ** 3}
        isLive={true}
      />,
    );

    expect(screen.getByTestId("vram-gauge")).not.toHaveClass("opacity-50");
  });
});
