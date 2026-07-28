import { Outlet } from "react-router-dom";

import { AppHeader } from "./AppHeader";

export function AppLayout() {
  return (
    <div className="flex h-screen flex-col bg-gray-950">
      <AppHeader />
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
