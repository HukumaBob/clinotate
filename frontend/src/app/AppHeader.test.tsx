import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppHeader } from "./AppHeader";
import { useAuth } from "../features/auth/useAuth";

vi.mock("../features/auth/useAuth", () => ({
  useAuth: vi.fn(),
}));

function mockAuth(role: "annotator" | "reviewer" | "admin" | null) {
  vi.mocked(useAuth).mockImplementation((selector) =>
    selector({
      token: "t",
      user: role ? { id: 1, email: "u@example.com", role } : null,
      isAuthenticated: true,
      login: vi.fn(),
      logout: vi.fn(),
    } as never)
  );
}

describe("AppHeader settings icon", () => {
  it("shows a Settings link for an admin user", () => {
    mockAuth("admin");
    render(<AppHeader />, { wrapper: MemoryRouter });
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });

  it("hides the Settings link for a non-admin user", () => {
    mockAuth("annotator");
    render(<AppHeader />, { wrapper: MemoryRouter });
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
  });
});

describe("AppHeader navigation", () => {
  it("links QC to /qc and no longer shows Results", () => {
    mockAuth("admin");
    render(<AppHeader />, { wrapper: MemoryRouter });
    expect(screen.getByRole("link", { name: "QC" })).toHaveAttribute("href", "/qc");
    expect(screen.queryByText("Results")).not.toBeInTheDocument();
  });
});

describe("AppHeader branding", () => {
  it("shows the logo as a link to the About page, with no About nav item", () => {
    mockAuth("annotator");
    render(<AppHeader />, { wrapper: MemoryRouter });
    const logo = screen.getByRole("img", { name: "AIIRIS DX" });
    expect(logo.closest("a")).toHaveAttribute("href", "/about");
    expect(screen.queryByText("Endoscopy Annotation Platform")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("app-header-nav-item").map((el) => el.textContent)).not.toContain("About");
  });
});
