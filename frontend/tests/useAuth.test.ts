import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { useAuth } from "../src/features/auth/useAuth";

describe("useAuth", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("starts unauthenticated when no token is stored", () => {
    const { result } = renderHook(() => useAuth());
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it("starts authenticated when a token is already stored", async () => {
    localStorage.setItem("endoscopy_auth_token", "existing-token");
    vi.resetModules();
    const { useAuth: freshUseAuth } = await import("../src/features/auth/useAuth");

    const { result } = renderHook(() => freshUseAuth());
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("existing-token");
  });

  it("logs in, stores the token, and fetches the current user", async () => {
    vi.spyOn(apiClient, "POST").mockResolvedValueOnce({
      data: { access_token: "fake-token", token_type: "bearer" },
      error: undefined,
      response: new Response(),
    } as never);
    vi.spyOn(apiClient, "GET").mockResolvedValueOnce({
      data: { id: 1, email: "test@example.com", role: "annotator" },
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.login("test@example.com", "password123");
    });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(result.current.user?.email).toBe("test@example.com");
    expect(localStorage.getItem("endoscopy_auth_token")).toBe("fake-token");
  });

  it("logout clears the token and user", async () => {
    vi.spyOn(apiClient, "POST").mockResolvedValueOnce({
      data: { access_token: "fake-token", token_type: "bearer" },
      error: undefined,
      response: new Response(),
    } as never);
    vi.spyOn(apiClient, "GET").mockResolvedValueOnce({
      data: { id: 1, email: "test@example.com", role: "annotator" },
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.login("test@example.com", "password123");
    });

    act(() => {
      result.current.logout();
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(localStorage.getItem("endoscopy_auth_token")).toBeNull();
  });
});
