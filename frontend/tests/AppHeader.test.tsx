import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppHeader } from "../src/app/AppHeader";
import { useAuth } from "../src/features/auth/useAuth";

function renderHeader(path = "/media") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppHeader />
    </MemoryRouter>,
  );
}

function renderHeaderWithRoutes(path = "/media") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/media" element={<AppHeader />} />
        <Route path="/login" element={<div>Login page content</div>} />
      </Routes>
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
    expect(navItems).toEqual(["Tags", "Media", "Sequences", "Dataset", "Train", "QC"]);
  });

  it("renders Media as a real link to /media", () => {
    renderHeader();

    const mediaLink = screen.getByRole("link", { name: "Media" });
    expect(mediaLink).toHaveAttribute("href", "/media");
  });

  it("renders Tags as a real link to /tags", () => {
    renderHeader();

    const tagsLink = screen.getByRole("link", { name: "Tags" });
    expect(tagsLink).toHaveAttribute("href", "/tags");
  });

  it("renders Sequences as a real link to /sequences", () => {
    renderHeader();

    const sequencesLink = screen.getByRole("link", { name: "Sequences" });
    expect(sequencesLink).toHaveAttribute("href", "/sequences");
  });

  it("renders QC as a real link to /qc and no longer has a Results item", () => {
    renderHeader();

    expect(screen.getByRole("link", { name: "QC" })).toHaveAttribute("href", "/qc");
    expect(screen.queryByText("Results")).not.toBeInTheDocument();
  });

  it("renders Dataset as a real link to /datasets", () => {
    renderHeader();

    const datasetsLink = screen.getByRole("link", { name: "Dataset" });
    expect(datasetsLink).toHaveAttribute("href", "/datasets");
  });

  it("renders Train as a real link to /train", () => {
    renderHeader();

    const trainLink = screen.getByRole("link", { name: "Train" });
    expect(trainLink).toHaveAttribute("href", "/train");
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

  it("navigates to /login when the Log out button is clicked", async () => {
    renderHeaderWithRoutes();

    await userEvent.click(screen.getByRole("button", { name: "Log out" }));

    expect(screen.getByText("Login page content")).toBeInTheDocument();
  });

  it("highlights Media as active when the current path is /media", () => {
    renderHeader("/media");

    expect(screen.getByRole("link", { name: "Media" })).toHaveAttribute("aria-current", "page");
  });
});
