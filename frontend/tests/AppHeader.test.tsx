import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppHeader } from "../src/app/AppHeader";
import { useAuth } from "../src/features/auth/useAuth";

function renderHeader(path = "/videos") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppHeader />
    </MemoryRouter>,
  );
}

describe("AppHeader", () => {
  beforeEach(() => {
    useAuth.setState({
      token: "test-token",
      user: { id: 1, email: "annotator@example.com", role: "annotator" },
      isAuthenticated: true,
    });
  });

  it("renders all six nav items in spec order", () => {
    renderHeader();

    const navItems = screen.getAllByTestId("app-header-nav-item").map((el) => el.textContent);
    expect(navItems).toEqual(["Media", "Sequences", "Tags", "Dataset", "Train", "Results"]);
  });

  it("renders Media as a real link to /videos", () => {
    renderHeader();

    const mediaLink = screen.getByRole("link", { name: "Media" });
    expect(mediaLink).toHaveAttribute("href", "/videos");
  });

  it("does not render the other five items as links", () => {
    renderHeader();

    for (const label of ["Sequences", "Tags", "Dataset", "Train", "Results"]) {
      expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
    }
  });

  it("shows the current user's email when authenticated", () => {
    renderHeader();

    expect(screen.getByText("annotator@example.com")).toBeInTheDocument();
  });

  it("calls logout when the Log out button is clicked", async () => {
    const logoutSpy = vi.fn();
    useAuth.setState({
      token: "test-token",
      user: { id: 1, email: "annotator@example.com", role: "annotator" },
      isAuthenticated: true,
      logout: logoutSpy,
    });

    renderHeader();
    await userEvent.click(screen.getByRole("button", { name: "Log out" }));

    expect(logoutSpy).toHaveBeenCalledOnce();
  });

  it("highlights Media as active when the current path is /videos", () => {
    renderHeader("/videos");

    expect(screen.getByRole("link", { name: "Media" })).toHaveAttribute("aria-current", "page");
  });
});
