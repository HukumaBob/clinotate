import { useState } from "react";

import { useEvaluationTypes, useProcedures } from "../../entities/useTaxonomy";
import type { components } from "../../shared/api/generated/schema";
import { CategoryForm } from "./CategoryForm";
import { ClassificationsPanel } from "./ClassificationsPanel";
import { ProceduresPanel } from "./ProceduresPanel";
import { TagForm } from "./TagForm";
import { TagsTable } from "./TagsTable";

type LabelRead = components["schemas"]["LabelRead"];
type CategoryRead = components["schemas"]["CategoryRead"];

export function TagsPage() {
  const proceduresQuery = useProcedures();
  const evaluationTypesQuery = useEvaluationTypes();

  const [procedureId, setProcedureId] = useState<number | null>(null);
  const [evaluationTypeId, setEvaluationTypeId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [formState, setFormState] = useState<"closed" | "new" | LabelRead>("closed");
  const [categoryFormState, setCategoryFormState] = useState<"closed" | "new" | CategoryRead>("closed");
  const [showProcedures, setShowProcedures] = useState(false);
  const [showClassifications, setShowClassifications] = useState(false);

  const procedures = proceduresQuery.data ?? [];
  const evaluationTypes = evaluationTypesQuery.data ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-950 p-8 text-gray-100">
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <span>Classification</span>
          <select
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100"
            value={evaluationTypeId ?? ""}
            onChange={(e) => setEvaluationTypeId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">All</option>
            {evaluationTypes.map((evaluationType) => (
              <option key={evaluationType.id} value={evaluationType.id}>
                {evaluationType.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span>Procedure</span>
          <select
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100"
            value={procedureId ?? ""}
            onChange={(e) => setProcedureId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">All</option>
            {procedures.map((procedure) => (
              <option key={procedure.id} value={procedure.id}>
                {procedure.name}
              </option>
            ))}
          </select>
        </label>
        <input
          type="text"
          placeholder="Search…"
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-100 hover:bg-gray-800"
            onClick={() => setShowProcedures((value) => !value)}
          >
            {showProcedures ? "Hide procedures" : "Manage procedures"}
          </button>
          <button
            type="button"
            className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-100 hover:bg-gray-800"
            onClick={() => setShowClassifications((value) => !value)}
          >
            {showClassifications ? "Hide classifications" : "Manage classifications"}
          </button>
          <button
            type="button"
            className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-100 hover:bg-gray-800"
            onClick={() => {
              setFormState("closed");
              setCategoryFormState("new");
            }}
          >
            + New parent tag
          </button>
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
            onClick={() => {
              setCategoryFormState("closed");
              setFormState("new");
            }}
          >
            + New tag
          </button>
        </div>
      </div>

      {showProcedures && <ProceduresPanel />}
      {showClassifications && <ClassificationsPanel />}

      {formState !== "closed" && (
        <div className="mb-4 shrink-0 rounded border border-gray-800 bg-gray-900 p-4">
          <TagForm
            defaultProcedureId={procedureId}
            editingLabel={formState === "new" ? null : formState}
            onDone={() => setFormState("closed")}
          />
        </div>
      )}

      {categoryFormState !== "closed" && (
        <div className="mb-4 shrink-0 rounded border border-gray-800 bg-gray-900 p-4">
          <CategoryForm
            defaultProcedureId={procedureId}
            editingCategory={categoryFormState === "new" ? null : categoryFormState}
            onDone={() => setCategoryFormState("closed")}
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <TagsTable
          procedureId={procedureId}
          evaluationTypeId={evaluationTypeId}
          search={search}
          onEditLabel={(label) => {
            setCategoryFormState("closed");
            setFormState(label);
          }}
          onEditCategory={(category) => {
            setFormState("closed");
            setCategoryFormState(category);
          }}
        />
      </div>
    </div>
  );
}
