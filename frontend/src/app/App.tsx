import type { JSX } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { LoginPage } from "../features/auth/LoginPage";
import { useAuth } from "../features/auth/useAuth";

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
              <div className="p-8 text-gray-100">Videos page placeholder</div>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
