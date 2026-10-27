import type { JSX } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { SequenceGridPage } from "../features/annotation/SequenceGridPage";
import { SequencesPage } from "../features/annotation/SequencesPage";
import { AboutPage } from "../features/about/AboutPage";
import { LoginPage } from "../features/auth/LoginPage";
import { useAuth } from "../features/auth/useAuth";
import { DatasetsPage } from "../features/datasets/DatasetsPage";
import { MediaPage } from "../features/media/MediaPage";
import { QcPage } from "../features/qc/QcPage";
import { AbComparePage } from "../features/qc/AbComparePage";
import { RunViewPage } from "../features/qc/RunViewPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { TagsPage } from "../features/tags/TagsPage";
import { TrainPage } from "../features/training/TrainPage";
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
          <Route path="/media" element={<MediaPage />} />
          <Route path="/tags" element={<TagsPage />} />
          <Route path="/sequences" element={<SequencesPage />} />
          <Route path="/sequences/:sequenceId" element={<SequenceGridPage />} />
          <Route path="/datasets" element={<DatasetsPage />} />
          <Route path="/train" element={<TrainPage />} />
          <Route path="/qc" element={<QcPage />} />
          <Route path="/qc/compare/:runA/:runB" element={<AbComparePage />} />
          <Route path="/qc/:runId" element={<RunViewPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
