import { Link, useLocation, useNavigate } from "react-router-dom";

import logo from "../assets/logo.svg";
import { useAuth } from "../features/auth/useAuth";
import { FullscreenButton } from "./FullscreenButton";

const NAV_ITEMS = [
  { label: "Tags", path: "/tags" },
  { label: "Media", path: "/media" },
  { label: "Sequences", path: "/sequences" },
  { label: "Dataset", path: "/datasets" },
  { label: "Train", path: "/train" },
  { label: "QC", path: "/qc" },
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
        <Link to="/about" aria-label="About" className="flex items-center">
          <img src={logo} alt="AIIRIS DX" className="h-5 w-auto" />
        </Link>
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
          <FullscreenButton />
          {user.role === "admin" && (
            <Link
              to="/settings"
              aria-label="Settings"
              className="text-lg text-gray-300 hover:text-gray-100"
            >
              ⚙️
            </Link>
          )}
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
