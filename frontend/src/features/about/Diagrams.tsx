const STEPS = [
  { id: "tags", title: "Tags", sub: "Taxonomy" },
  { id: "media", title: "Media", sub: "Videos" },
  { id: "sequences", title: "Sequences", sub: "Annotate frames" },
  { id: "dataset", title: "Dataset", sub: "Balance & export" },
  { id: "train", title: "Train", sub: "Fit models" },
  { id: "qc", title: "QC", sub: "Inspect on video" },
];

const BOX = "fill-gray-900 stroke-gray-700";
const LINE = "stroke-gray-600";
const TEXT = "fill-gray-200";
const SUB = "fill-gray-400";

interface WorkflowProps {
  onSelect: (id: string) => void;
}

export function WorkflowDiagram({ onSelect }: WorkflowProps) {
  return (
    <svg
      role="img"
      aria-label="Workflow: Tags, Media, Sequences, Dataset, Train, QC"
      viewBox="0 0 1000 130"
      className="w-full"
    >
      <defs>
        <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" className="fill-gray-500" />
        </marker>
      </defs>
      {STEPS.map((step, index) => {
        const x = index * 172;
        return (
          <g key={step.id} onClick={() => onSelect(step.id)} className="cursor-pointer">
            <rect x={x} y={20} width={140} height={90} rx={10} className={`${BOX} hover:stroke-blue-400`} />
            <circle cx={x + 24} cy={44} r={12} className="fill-blue-500/20 stroke-blue-400" />
            <text x={x + 24} y={49} textAnchor="middle" className="fill-blue-300 text-[13px] font-semibold">
              {index + 1}
            </text>
            <text x={x + 14} y={82} className={`${TEXT} text-[17px] font-semibold`}>
              {step.title}
            </text>
            <text x={x + 14} y={100} className={`${SUB} text-[12px]`}>
              {step.sub}
            </text>
            {index < STEPS.length - 1 && (
              <line x1={x + 142} y1={65} x2={x + 170} y2={65} className={LINE} strokeWidth={2} markerEnd="url(#wf-arrow)" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

const MODULES = ["auth", "taxonomy", "media", "annotation", "datasets", "training", "jobs"];

function Node({ x, y, w, h, title, sub }: { x: number; y: number; w: number; h: number; title: string; sub?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} className={BOX} />
      <text x={x + w / 2} y={y + (sub ? h / 2 - 2 : h / 2 + 5)} textAnchor="middle" className={`${TEXT} text-[14px] font-medium`}>
        {title}
      </text>
      {sub && (
        <text x={x + w / 2} y={y + h / 2 + 15} textAnchor="middle" className={`${SUB} text-[11px]`}>
          {sub}
        </text>
      )}
    </g>
  );
}

export function ArchitectureDiagram() {
  return (
    <svg
      role="img"
      aria-label="Architecture: React app, FastAPI core API, PostgreSQL, Redis, MinIO and GPU workers"
      viewBox="0 0 900 430"
      className="w-full"
    >
      <defs>
        <marker id="ar-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" className="fill-gray-500" />
        </marker>
      </defs>

      <Node x={290} y={10} w={320} h={52} title="React SPA" sub="Vite · TanStack Query · Zustand" />
      <line x1={450} y1={62} x2={450} y2={98} className={LINE} strokeWidth={2} markerEnd="url(#ar-arrow)" />
      <text x={462} y={85} className={`${SUB} text-[11px]`}>REST · OpenAPI</text>

      <rect x={60} y={100} width={780} height={110} rx={12} className="fill-gray-900/60 stroke-blue-500/60" />
      <text x={80} y={124} className="fill-blue-300 text-[13px] font-semibold">Core API — FastAPI modular monolith</text>
      {MODULES.map((name, i) => (
        <g key={name}>
          <rect x={80 + i * 108} y={144} width={98} height={44} rx={6} className={BOX} />
          <text x={80 + i * 108 + 49} y={171} textAnchor="middle" className={`${TEXT} text-[13px]`}>
            {name}
          </text>
        </g>
      ))}

      <line x1={160} y1={210} x2={160} y2={268} className={LINE} strokeWidth={2} markerEnd="url(#ar-arrow)" />
      <line x1={450} y1={210} x2={450} y2={268} className={LINE} strokeWidth={2} markerEnd="url(#ar-arrow)" />
      <line x1={740} y1={210} x2={740} y2={268} className={LINE} strokeWidth={2} markerEnd="url(#ar-arrow)" />
      <Node x={90} y={270} w={140} h={54} title="PostgreSQL" sub="data · pgvector" />
      <Node x={380} y={270} w={140} h={54} title="Redis" sub="Celery broker" />
      <Node x={670} y={270} w={140} h={54} title="MinIO" sub="video · frames · weights" />

      <line x1={420} y1={324} x2={330} y2={366} className={LINE} strokeWidth={2} markerEnd="url(#ar-arrow)" />
      <line x1={480} y1={324} x2={570} y2={366} className={LINE} strokeWidth={2} markerEnd="url(#ar-arrow)" />
      <Node x={190} y={368} w={280} h={54} title="ML worker (GPU)" sub="SAM 2.1 · SAM 3 · YOLO training" />
      <Node x={500} y={368} w={240} h={54} title="Transcode worker (CPU)" sub="video → browser playback" />
    </svg>
  );
}
