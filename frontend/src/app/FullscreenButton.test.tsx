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
  Object.defineProperty(window, "matchMedia", { value: undefined, configurable: true, writable: true });
});

/** A matchMedia whose `(display-mode: fullscreen)` result the test controls:
 * the browser reports F11 this way, without touching the Fullscreen API. */
function mockDisplayMode() {
  let matches = false;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({
      get matches() {
        return matches;
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }),
  });
  return (value: boolean) => {
    matches = value;
    listeners.forEach((fn) => fn());
  };
}

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

  it("notices F11, which the Fullscreen API does not report, and cannot undo it itself", () => {
    const setDisplayMode = mockDisplayMode();
    render(<FullscreenButton />);
    act(() => setDisplayMode(true));
    const button = screen.getByRole("button", { name: "Exit full screen" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Press F11 to exit full screen");
    expect(exitFullscreen).not.toHaveBeenCalled();
    act(() => setDisplayMode(false));
    expect(screen.getByRole("button", { name: "Enter full screen" })).toBeEnabled();
  });
});
