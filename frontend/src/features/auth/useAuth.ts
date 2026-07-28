import { create } from "zustand";

import { apiClient, setAuthToken } from "../../shared/api/client";

const TOKEN_STORAGE_KEY = "endoscopy_auth_token";

interface AuthUser {
  id: number;
  email: string;
  role: "annotator" | "reviewer" | "admin";
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const storedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
if (storedToken) {
  setAuthToken(storedToken);
}

export const useAuth = create<AuthState>((set) => ({
  token: storedToken,
  user: null,
  isAuthenticated: storedToken !== null,

  login: async (email: string, password: string) => {
    const loginResult = await apiClient.POST("/auth/login", {
      body: { email, password },
    });
    if (!loginResult.data) {
      throw new Error("Login failed");
    }
    const token = loginResult.data.access_token;
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    setAuthToken(token);

    const meResult = await apiClient.GET("/auth/me", {});
    if (!meResult.data) {
      throw new Error("Failed to fetch current user");
    }

    set({ token, user: meResult.data as AuthUser, isAuthenticated: true });
  },

  logout: () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setAuthToken(null);
    set({ token: null, user: null, isAuthenticated: false });
  },
}));

if (storedToken) {
  apiClient.GET("/auth/me", {}).then((meResult) => {
    if (meResult.data) {
      useAuth.setState({ user: meResult.data as AuthUser, isAuthenticated: true });
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      setAuthToken(null);
      useAuth.setState({ token: null, user: null, isAuthenticated: false });
    }
  });
}
