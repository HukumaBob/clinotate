import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { AppLayout } from "../src/app/AppLayout";
import { useAuth } from "../src/features/auth/useAuth";

describe("AppLayout", () => {
  beforeEach(() => {
    useAuth.setState({
      token: "test-token",
      user: { id: 1, email: "annotator@example.com", role: "annotator" },
      isAuthenticated: true,
    });
  });

  it("renders the header and the nested route's content", () => {
    const router = createMemoryRouter(
      [
        {
          element: <AppLayout />,
          children: [{ path: "/videos", element: <div>Videos page content</div> }],
        },
      ],
      { initialEntries: ["/videos"] },
    );

    render(<RouterProvider router={router} />);

    expect(screen.getByText("Endoscopy Annotation Platform")).toBeInTheDocument();
    expect(screen.getByText("Videos page content")).toBeInTheDocument();
  });
});
