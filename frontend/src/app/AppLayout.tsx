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
