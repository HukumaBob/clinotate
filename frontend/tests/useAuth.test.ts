import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient as topLevelApiClient } from "../src/shared/api/client";
import { useAuth as topLevelUseAuth } from "../src/features/auth/useAuth";

const STORAGE_KEY = "endoscopy_auth_token";

describe("useAuth hydration on module load", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("hydrates user from /auth/me when a token already exists in localStorage", async () => {
    localStorage.setItem(STORAGE_KEY, "existing-token");

    const { apiClient } = await import("../src/shared/api/client");
    const meSpy = vi
      .spyOn(apiClient, "GET")
      .mockResolvedValue({ data: { id: 7, email: "reload@example.com", role: "annotator" }, error: undefined, response: new Response() } as never);

    const { useAuth } = await import("../src/features/auth/useAuth");

    await vi.waitFor(() => {
      expect(useAuth.getState().user).toEqual({ id: 7, email: "reload@example.com", role: "annotator" });
    });

    expect(meSpy).toHaveBeenCalledWith("/auth/me", {});
    expect(useAuth.getState().isAuthenticated).toBe(true);
  });

  it("leaves user null when no token exists in localStorage", async () => {
    const { apiClient } = await import("../src/shared/api/client");
    const meSpy = vi.spyOn(apiClient, "GET");

    const { useAuth } = await import("../src/features/auth/useAuth");

    expect(useAuth.getState().user).toBeNull();
    expect(useAuth.getState().isAuthenticated).toBe(false);
    expect(meSpy).not.toHaveBeenCalled();
  });

  it("logs out (clears token/user) if hydration's /auth/me call fails", async () => {
    localStorage.setItem(STORAGE_KEY, "stale-token");

    const { apiClient } = await import("../src/shared/api/client");
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: undefined, error: { detail: "Unauthorized" }, response: new Response() } as never);

    const { useAuth } = await import("../src/features/auth/useAuth");

    await vi.waitFor(() => {
      expect(useAuth.getState().isAuthenticated).toBe(false);
    });

    expect(useAuth.getState().user).toBeNull();
    expect(useAuth.getState().token).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("useAuth login/logout actions", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("starts unauthenticated when no token is stored", () => {
    const { result } = renderHook(() => topLevelUseAuth());
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it("logs in, stores the token, and fetches the current user", async () => {
    vi.spyOn(topLevelApiClient, "POST").mockResolvedValueOnce({
      data: { access_token: "fake-token", token_type: "bearer" },
      error: undefined,
      response: new Response(),
    } as never);
    vi.spyOn(topLevelApiClient, "GET").mockResolvedValueOnce({
      data: { id: 1, email: "test@example.com", role: "annotator" },
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => topLevelUseAuth());

    await act(async () => {
      await result.current.login("test@example.com", "password123");
    });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(result.current.user?.email).toBe("test@example.com");
    expect(localStorage.getItem("endoscopy_auth_token")).toBe("fake-token");
  });

  it("logout clears the token and user", async () => {
    vi.spyOn(topLevelApiClient, "POST").mockResolvedValueOnce({
      data: { access_token: "fake-token", token_type: "bearer" },
      error: undefined,
      response: new Response(),
    } as never);
    vi.spyOn(topLevelApiClient, "GET").mockResolvedValueOnce({
      data: { id: 1, email: "test@example.com", role: "annotator" },
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => topLevelUseAuth());
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
