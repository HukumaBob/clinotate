import { Link, useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../features/auth/useAuth";

const NAV_ITEMS = [
  { label: "Media", path: "/media" },
  { label: "Sequences", path: null },
  { label: "Tags", path: null },
  { label: "Dataset", path: null },
  { label: "Train", path: null },
  { label: "Results", path: null },
] as const;

export function AppHeader() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuth((state) => state.user);
  const logout = useAuth((state) => state.logout);

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-800 bg-gray-950 px-6 text-gray-100">
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
            onClick={handleLogout}
            className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-100 hover:bg-gray-800"
          >
            Log out
          </button>
        </div>
      )}
    </header>
  );
}
