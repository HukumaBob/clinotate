# Global App Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the six-item top-level navigation header specified in the UI/UX design spec, wired to real routes only where routes exist, visible on every protected screen.

**Architecture:** A presentational `AppHeader` component reads the current route (via `react-router-dom`'s `useLocation`) and the `useAuth` zustand store (email + logout). An `AppLayout` component renders `AppHeader` above an `<Outlet />`. `App.tsx` is restructured so a single `RequireAuth`-wrapped layout route holds all protected pages as nested routes, instead of each page independently wrapping itself in `RequireAuth`.

**Tech Stack:** React 18, TypeScript, react-router-dom v6 (`Outlet`, nested routes), zustand (existing `useAuth` store), Tailwind CSS (dark theme only, `darkMode: "class"`), Vitest + `@testing-library/react` + `@testing-library/user-event` for tests.

## Global Constraints

- Dark theme only — no light-background Tailwind classes (CLAUDE.md).
- English only in code, comments, and UI copy — no Russian anywhere in committed content (CLAUDE.md).
- TDD: write the failing test before the implementation for every task with logic (CLAUDE.md).
- Never write a hand-rolled `fetch()` — this component makes no new API calls (it only reads the existing `useAuth` store), so this constraint doesn't add work here, but no task in this plan should add one.
- Nav order is fixed: `Media → Sequences → Tags → Dataset → Train → Results` (UI/UX spec).
- Only **Media** is a real link (`/videos`); the other five render as non-interactive `<span>` elements — no `href`, no `onClick`, muted styling, `cursor-not-allowed` (design spec `docs/superpowers/specs/2026-07-28-global-app-header-design.md`).
- The header must be visible on every protected screen, including the frame editor inside Sequences (design spec).

---

## File Structure

- **Create `frontend/src/app/AppHeader.tsx`** — the header bar: platform name, six nav items, user email + logout button. Pure presentational component (no data fetching beyond `useAuth`).
- **Create `frontend/tests/AppHeader.test.tsx`** — unit tests for `AppHeader`.
- **Create `frontend/src/app/AppLayout.tsx`** — renders `<AppHeader />` above `<Outlet />`.
- **Modify `frontend/src/app/App.tsx`** — replace per-page `RequireAuth` wrapping with a single layout route holding nested protected routes.
- **Modify `frontend/src/features/auth/useAuth.ts`** — hydrate `user` from `GET /auth/me` on store creation when a token already exists in `localStorage`, so a page reload (or a fresh app load with an existing session) doesn't leave `user: null` while `isAuthenticated` is `true`.

No other files change. `VideoListPage` and `SequenceGridPage` keep their own `min-h-screen` root `div`s unmodified — nesting them under a header with `min-h-screen` still gives correct visual height (the header just adds fixed height on top; this is a pure layout composition, not a change to either page's own markup).

---

### Task 1: `AppHeader` component

**Files:**
- Create: `frontend/src/app/AppHeader.tsx`
- Test: `frontend/tests/AppHeader.test.tsx`

**Interfaces:**
- Consumes: `useAuth` from `frontend/src/features/auth/useAuth.ts` — reads `state.user` (shape `{ id: number; email: string; role: "annotator" | "reviewer" | "admin" } | null`), `state.logout` (`() => void`). Uses `useLocation` and `useNavigate` from `react-router-dom` (already a project dependency, used elsewhere e.g. `LoginPage.tsx`).
- Produces: `export function AppHeader(): JSX.Element` — a named export, no props. Later tasks (`AppLayout`) import it as `import { AppHeader } from "./AppHeader"`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/AppHeader.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/AppHeader.test.tsx`
Expected: FAIL — `Cannot find module '../src/app/AppHeader'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/app/AppHeader.tsx`:

```tsx
import { Link, useLocation } from "react-router-dom";

import { useAuth } from "../features/auth/useAuth";

const NAV_ITEMS = [
  { label: "Media", path: "/videos" },
  { label: "Sequences", path: null },
  { label: "Tags", path: null },
  { label: "Dataset", path: null },
  { label: "Train", path: null },
  { label: "Results", path: null },
] as const;

export function AppHeader() {
  const location = useLocation();
  const user = useAuth((state) => state.user);
  const logout = useAuth((state) => state.logout);

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-gray-800 bg-gray-950 px-6 text-gray-100">
      <div className="flex items-center gap-8">
        <span className="font-semibold">Endoscopy Annotation Platform</span>
        <nav className="flex items-center gap-6">
          {NAV_ITEMS.map((item) =>
            item.path ? (
              <Link
                key={item.label}
                to={item.path}
                data-testid="app-header-nav-item"
                aria-current={location.pathname === item.path ? "page" : undefined}
                className={
                  location.pathname === item.path
                    ? "text-sm font-medium text-blue-400"
                    : "text-sm font-medium text-gray-300 hover:text-gray-100"
                }
              >
                {item.label}
              </Link>
            ) : (
              <span
                key={item.label}
                data-testid="app-header-nav-item"
                className="cursor-not-allowed text-sm font-medium text-gray-600"
              >
                {item.label}
              </span>
            ),
          )}
        </nav>
      </div>
      {user && (
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-400">{user.email}</span>
          <button
            type="button"
            onClick={logout}
            className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-100 hover:bg-gray-800"
          >
            Log out
          </button>
        </div>
      )}
    </header>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/AppHeader.test.tsx`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/AppHeader.tsx frontend/tests/AppHeader.test.tsx
git commit -m "feat: add AppHeader with six-item nav and user/logout controls"
```

---

### Task 2: `AppLayout` component

**Files:**
- Create: `frontend/src/app/AppLayout.tsx`
- Test: `frontend/tests/AppLayout.test.tsx`

**Interfaces:**
- Consumes: `AppHeader` from `./AppHeader` (Task 1). `Outlet` from `react-router-dom`.
- Produces: `export function AppLayout(): JSX.Element` — a named export, no props, renders `<AppHeader />` then `<Outlet />`. Task 3 imports it as `import { AppLayout } from "./AppLayout"` and uses it as a parent route element.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/AppLayout.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/AppLayout.test.tsx`
Expected: FAIL — `Cannot find module '../src/app/AppLayout'`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/app/AppLayout.tsx`:

```tsx
import { Outlet } from "react-router-dom";

import { AppHeader } from "./AppHeader";

export function AppLayout() {
  return (
    <div className="min-h-screen bg-gray-950">
      <AppHeader />
      <Outlet />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/AppLayout.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/AppLayout.tsx frontend/tests/AppLayout.test.tsx
git commit -m "feat: add AppLayout rendering AppHeader above routed content"
```

---

### Task 3: Wire `AppLayout` into `App.tsx`'s routing

**Files:**
- Modify: `frontend/src/app/App.tsx`

**Interfaces:**
- Consumes: `AppLayout` from `./AppLayout` (Task 2). Existing `RequireAuth`, `SequenceGridPage`, `LoginPage`, `useAuth`, `VideoListPage` — all unchanged, same import paths as today.
- Produces: no new exports — `App.tsx`'s default routing behavior for existing tests/consumers is unchanged (same URLs resolve to the same pages), only the component tree gains a wrapping layout.

This task has no isolated unit test of its own — Task 4 (manual browser verification) is what proves the routing restructure works end-to-end, since `App.tsx` wires together components already covered by their own tests (Task 1, Task 2, and the pre-existing `SequenceGridPage`/`VideoListPage`/`LoginPage` tests). Run the full existing frontend suite after this change to confirm nothing regressed.

- [ ] **Step 1: Read the current file**

Current `frontend/src/app/App.tsx` (for reference — this is what you're replacing):

```tsx
import type { JSX } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { SequenceGridPage } from "../features/annotation/SequenceGridPage";
import { LoginPage } from "../features/auth/LoginPage";
import { useAuth } from "../features/auth/useAuth";
import { VideoListPage } from "../features/media/VideoListPage";

function RequireAuth({ children }: { children: JSX.Element }) {
  const isAuthenticated = useAuth((state) => state.isAuthenticated);
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/videos"
          element={
            <RequireAuth>
              <VideoListPage />
            </RequireAuth>
          }
        />
        <Route
          path="/videos/:videoId/sequences/:sequenceId"
          element={
            <RequireAuth>
              <SequenceGridPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 2: Replace with the layout-nested version**

Replace the full contents of `frontend/src/app/App.tsx`:

```tsx
import type { JSX } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { SequenceGridPage } from "../features/annotation/SequenceGridPage";
import { LoginPage } from "../features/auth/LoginPage";
import { useAuth } from "../features/auth/useAuth";
import { VideoListPage } from "../features/media/VideoListPage";
import { AppLayout } from "./AppLayout";

function RequireAuth({ children }: { children: JSX.Element }) {
  const isAuthenticated = useAuth((state) => state.isAuthenticated);
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/videos" element={<VideoListPage />} />
          <Route path="/videos/:videoId/sequences/:sequenceId" element={<SequenceGridPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 3: Run the full frontend test suite to confirm no regressions**

Run: `cd frontend && npm test -- --run`
Expected: All existing tests pass, plus the `AppHeader`/`AppLayout` tests from Tasks 1–2. No test file references the old per-page `RequireAuth` wrapping directly, so nothing else should need updating.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/App.tsx
git commit -m "feat: route protected pages through AppLayout for a shared header"
```

---

### Task 3.5: Hydrate `useAuth`'s `user` on store creation

**Why this task exists:** manual browser verification of Task 3 found that `AppHeader`'s email/logout block never appears on a page load that starts from an existing session (token already in `localStorage`, no `login()` call in this page load) — only right after submitting the login form. Root cause: `useAuth`'s initial state hardcodes `user: null` and only ever sets `user` inside `login()`. `isAuthenticated` is correctly derived from the stored token, but `user` has no equivalent hydration path. `AppHeader.tsx`'s `{user && (...)}` condition is correct as written (Task 1) — the defect is in the store providing stale data, not in the header reading it.

**Files:**
- Modify: `frontend/src/features/auth/useAuth.ts` (currently 51 lines — full file below)
- Test: `frontend/tests/useAuth.test.ts`

**Interfaces:**
- Consumes: `apiClient` and `setAuthToken` from `frontend/src/shared/api/client.ts` (already imported in this file). `apiClient.GET("/auth/me", {})` — already used inside `login()`, same call shape, returns `{ data?: AuthUser, ... }` on success.
- Produces: no new exports — `useAuth`'s public shape (`token`, `user`, `isAuthenticated`, `login`, `logout`) is unchanged. `AppHeader` (Task 1) already consumes `state.user`; after this task, `state.user` is a real value on a reloaded page with a valid stored token, not just after an in-session `login()` call. No consumer needs to change.

Current full contents of `frontend/src/features/auth/useAuth.ts`:

```ts
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
```

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/useAuth.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";

const STORAGE_KEY = "endoscopy_auth_token";

describe("useAuth hydration on module load", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("hydrates user from /auth/me when a token already exists in localStorage", async () => {
    localStorage.setItem(STORAGE_KEY, "existing-token");

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
    const meSpy = vi.spyOn(apiClient, "GET");

    const { useAuth } = await import("../src/features/auth/useAuth");

    expect(useAuth.getState().user).toBeNull();
    expect(useAuth.getState().isAuthenticated).toBe(false);
    expect(meSpy).not.toHaveBeenCalled();
  });

  it("logs out (clears token/user) if hydration's /auth/me call fails", async () => {
    localStorage.setItem(STORAGE_KEY, "stale-token");

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/useAuth.test.ts`
Expected: FAIL — the first test times out waiting for `user` to become non-null (current code never calls `/auth/me` outside `login()`); the third test times out the same way. The second test passes already (no token means no change in behavior).

- [ ] **Step 3: Write the implementation**

Replace the full contents of `frontend/src/features/auth/useAuth.ts`:

```ts
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
```

The hydration call runs once at module load, after `useAuth` is defined (so `useAuth.setState` is available), guarded by the same `storedToken` check already used to seed `token`/`isAuthenticated`. On success it fills in `user`. On failure (expired/invalid token) it clears the session the same way `logout()` does, rather than leaving a stale, unusable token in `localStorage` and an inconsistent `isAuthenticated: true`/`user: null` state.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/useAuth.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Run the full frontend test suite to confirm no regressions**

Run: `cd frontend && npm test -- --run`
Expected: All existing tests pass, plus the 3 new `useAuth` tests. `AppHeader.test.tsx` (Task 1) already calls `useAuth.setState(...)` directly in its own `beforeEach`, overriding whatever the module-load hydration produced — it is unaffected by this change.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/auth/useAuth.ts frontend/tests/useAuth.test.ts
git commit -m "fix: hydrate useAuth's user from /auth/me on store creation"
```

---

### Task 4: Manual browser verification

**Files:** none (verification only, per CLAUDE.md's testing philosophy — backend `TestClient` and frontend unit tests both mock past cross-cutting concerns like this).

**Interfaces:** N/A.

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --reload &
cd frontend && npm run dev &
```

- [ ] **Step 2: Log in and confirm the header appears**

Open `http://localhost:5173/login` in a real browser, log in with any valid user. Confirm:
- The header bar is visible immediately after redirect to `/videos`.
- All six nav items appear in order: Media, Sequences, Tags, Dataset, Train, Results.
- Media is styled as an active/clickable link; the other five look visually disabled (muted, not-allowed cursor) and clicking them does nothing.
- The logged-in user's email appears on the right, next to a "Log out" button.

- [ ] **Step 3: Confirm the header persists into the frame editor**

Navigate into any sequence (`/videos/:videoId/sequences/:sequenceId`), open a frame in the editor. Confirm the header bar is still visible above the frame editor's two-column layout — it does not disappear or get pushed off-screen.

- [ ] **Step 4: Confirm logout works**

Click "Log out". Confirm the app redirects to `/login` and that navigating back to `/videos` redirects to `/login` again (session actually cleared, not just a UI change).

- [ ] **Step 5: Confirm the email/logout block survives a page reload**

While logged in (on `/videos` or in the frame editor), hard-reload the browser page (not a client-side navigation — an actual full page reload, e.g. Ctrl+R). Confirm the header still shows the user's email and "Log out" button immediately, without requiring a fresh login. This is the scenario Task 3.5 fixes — before that task, the header would render with the nav items but an empty right-hand side after a reload.

- [ ] **Step 6: Report results**

No commit for this task — it's a verification gate. If any check in Steps 2–5 fails, treat it as a bug: return to Task 1, Task 3, or Task 3.5 to fix it, re-run the affected task's tests, and repeat this task's manual verification before considering the plan complete.
