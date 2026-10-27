import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FullscreenButton } from "./FullscreenButton";

let fullscreenElement: Element | null = null;
const requestFullscreen = vi.fn(async () => {
  fullscreenElement = document.documentElement;
  document.dispatchEvent(new Event("fullscreenchange"));
});
const exitFullscreen = vi.fn(async () => {
  fullscreenElement = null;
  document.dispatchEvent(new Event("fullscreenchange"));
});

beforeEach(() => {
  fullscreenElement = null;
  requestFullscreen.mockClear();
  exitFullscreen.mockClear();
  Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
  Object.defineProperty(document, "fullscreenElement", { get: () => fullscreenElement, configurable: true });
  document.exitFullscreen = exitFullscreen;
  document.documentElement.requestFullscreen = requestFullscreen;
});

afterEach(() => {
  Object.defineProperty(document, "fullscreenEnabled", { value: undefined, configurable: true });
});

describe("FullscreenButton", () => {
  it("enters fullscreen and then offers to exit", async () => {
    const user = userEvent.setup();
    render(<FullscreenButton />);
    await user.click(screen.getByRole("button", { name: "Enter full screen" }));
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Exit full screen" })).toBeInTheDocument();
  });

  it("exits fullscreen", async () => {
    const user = userEvent.setup();
    render(<FullscreenButton />);
    await user.click(screen.getByRole("button", { name: "Enter full screen" }));
    await user.click(screen.getByRole("button", { name: "Exit full screen" }));
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Enter full screen" })).toBeInTheDocument();
  });

  it("follows a change made outside the button, such as pressing Esc", () => {
    render(<FullscreenButton />);
    act(() => {
      fullscreenElement = document.documentElement;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(screen.getByRole("button", { name: "Exit full screen" })).toBeInTheDocument();
  });

  it("renders nothing where fullscreen is not available", () => {
    Object.defineProperty(document, "fullscreenEnabled", { value: false, configurable: true });
    const { container } = render(<FullscreenButton />);
    expect(container).toBeEmptyDOMElement();
  });
});
