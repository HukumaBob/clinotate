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
