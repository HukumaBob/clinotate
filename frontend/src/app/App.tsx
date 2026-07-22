import type { JSX } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { FrameAnnotationPage } from "../features/annotation/FrameAnnotationPage";
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
          path="/frames/:frameId"
          element={
            <RequireAuth>
              <FrameAnnotationPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
