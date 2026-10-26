import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useProcedures } from "../../entities/useTaxonomy";
import { useVideos } from "../../entities/useVideos";
import { useSequencesList, useSequencesStats } from "../../entities/useSequencesList";
import { SequenceCard } from "./SequenceCard";

type LabeledFilter = "all" | "labeled" | "unlabeled";

const PAGE_SIZE = 25;

export function SequencesPage() {
  const navigate = useNavigate();
  const [procedureId, setProcedureId] = useState<number | null>(null);
  const [videoId, setVideoId] = useState<number | null>(null);
  const [labeled, setLabeled] = useState<LabeledFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const proceduresQuery = useProcedures();
  const videosQuery = useVideos();
  const statsQuery = useSequencesStats({ procedureId, videoId, search });
  const listQuery = useSequencesList({ procedureId, videoId, labeled, search, page, pageSize: PAGE_SIZE });

  const procedures = proceduresQuery.data ?? [];
  const videos = videosQuery.data ?? [];
  const stats = statsQuery.data;
  const sequences = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const pageCount = Math.ceil(total / PAGE_SIZE);

  function goToSequence(sequenceId: number) {
    navigate(`/sequences/${sequenceId}`);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-950 p-8 text-gray-100">
      <div className="mb-6 grid shrink-0 grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Total Sequences" value={stats?.total_sequences ?? 0} />
        <StatTile label="Total Frames" value={stats?.total_frames ?? 0} />
        <StatTile label="Labeled" value={stats?.labeled_sequences ?? 0} />
        <StatTile label="Unlabeled" value={stats?.unlabeled_sequences ?? 0} />
      </div>

      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <span>Procedure</span>
          <select
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100"
            value={procedureId ?? ""}
            onChange={(e) => {
              setProcedureId(e.target.value ? Number(e.target.value) : null);
              setPage(1);
            }}
          >
            <option value="">All procedures</option>
            {procedures.map((procedure) => (
              <option key={procedure.id} value={procedure.id}>
                {procedure.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span>Video</span>
          <select
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100"
            value={videoId ?? ""}
            onChange={(e) => {
              setVideoId(e.target.value ? Number(e.target.value) : null);
              setPage(1);
            }}
          >
            <option value="">All videos</option>
            {videos.map((video) => (
              <option key={video.id} value={video.id}>
                {video.title}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span>Status</span>
          <select
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100"
            value={labeled}
            onChange={(e) => {
              setLabeled(e.target.value as LabeledFilter);
              setPage(1);
            }}
          >
            <option value="all">All</option>
            <option value="labeled">Labeled</option>
            <option value="unlabeled">Unlabeled</option>
          </select>
        </label>

        <input
          type="text"
          placeholder="Search by name..."
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {sequences.length === 0 ? (
          <p className="text-gray-400">No sequences found</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {sequences.map((sequence) => (
              <SequenceCard key={sequence.id} sequence={sequence} onAnnotate={goToSequence} />
            ))}
          </div>
        )}

        {pageCount > 1 && (
          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="rounded border border-gray-700 px-2 py-1 text-sm text-gray-100 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-sm text-gray-400">
              Page {page} of {pageCount}
            </span>
            <button
              type="button"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => p + 1)}
              className="rounded border border-gray-700 px-2 py-1 text-sm text-gray-100 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4 text-center">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs text-gray-400">{label}</div>
    </div>
  );
}
