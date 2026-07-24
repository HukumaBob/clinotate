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
