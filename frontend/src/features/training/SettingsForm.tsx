import {
  isChanged,
  type SettingField,
  type SettingsSchema,
  type SettingsValues,
  type SettingValue,
} from "./settingsLogic";

interface SettingsFormProps {
  schema: SettingsSchema;
  values: SettingsValues;
  errors: Record<string, string>;
  onChange: (key: string, value: SettingValue) => void;
  onReset: (key: string) => void;
  onApplyPreset: (presetId: string) => void;
  // The parent shows <PresetBar> elsewhere (the form puts it in its left column).
  hidePresets?: boolean;
}

const INPUT =
  "h-8 w-full rounded border border-gray-700 bg-gray-950 px-2 text-sm text-gray-100 aria-[invalid=true]:border-red-600";

function rangeText(field: SettingField): string | null {
  const { min, max } = field;
  if (min != null && max != null) return `${min}–${max}`;
  if (min != null) return `≥ ${min}`;
  if (max != null) return `≤ ${max}`;
  return null;
}

function FieldInput({
  field,
  value,
  invalid,
  describedBy,
  onChange,
}: {
  field: SettingField;
  value: SettingValue;
  invalid: boolean;
  describedBy: string;
  onChange: (value: SettingValue) => void;
}) {
  const id = `setting-${field.key}`;
  if (field.type === "bool") {
    return (
      <input
        id={id}
        type="checkbox"
        className="h-4 w-4 accent-blue-500 [color-scheme:dark]"
        aria-describedby={describedBy}
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }
  if (field.type === "choice") {
    return (
      <select
        id={id}
        className={INPUT}
        aria-describedby={describedBy}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      >
        {(field.choices ?? []).map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      id={id}
      type="number"
      className={INPUT}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      min={field.min ?? undefined}
      max={field.max ?? undefined}
      step={field.step ?? (field.type === "float" ? "any" : 1)}
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
    />
  );
}

export function PresetBar({
  schema,
  onApplyPreset,
}: {
  schema: SettingsSchema;
  onApplyPreset: (presetId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] text-gray-400">Presets</span>
      <div
        role="group"
        aria-label="Presets"
        className="inline-flex flex-wrap self-start overflow-hidden rounded border border-gray-700"
      >
        {schema.presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            title={preset.description}
            className="h-8 border-r border-gray-700 px-3 text-[13px] text-gray-300 last:border-r-0 hover:bg-gray-800 hover:text-gray-100"
            onClick={() => onApplyPreset(preset.id)}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsForm({
  schema,
  values,
  errors,
  onChange,
  onReset,
  onApplyPreset,
  hidePresets = false,
}: SettingsFormProps) {
  return (
    <div className="flex flex-col gap-3">
      {!hidePresets && <PresetBar schema={schema} onApplyPreset={onApplyPreset} />}

      {schema.groups.map((group) => (
        <details
          key={group.id}
          open={group.id === "basic" || group.fields.some((f) => errors[f.key])}
          className="rounded border border-gray-800 bg-gray-950"
        >
          <summary className="cursor-pointer px-3 py-2 text-[15px] font-semibold text-gray-200">
            {group.label}
          </summary>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-3 pb-3 xl:grid-cols-3">
            {group.fields.map((field) => {
              const value = values[field.key] ?? null;
              const changed = isChanged(field, value);
              const error = errors[field.key];
              const range = rangeText(field);
              const helpId = `setting-${field.key}-help`;
              const errorId = `setting-${field.key}-error`;
              return (
                <div
                  key={field.key}
                  data-testid={`field-${field.key}`}
                  title={field.help}
                  className="flex min-w-0 flex-col gap-1"
                >
                  <div data-testid={`row-${field.key}`} className="flex items-center gap-2">
                    {field.type === "bool" && (
                      <FieldInput
                        field={field}
                        value={value}
                        invalid={Boolean(error)}
                        describedBy={error ? `${helpId} ${errorId}` : helpId}
                        onChange={(next) => onChange(field.key, next)}
                      />
                    )}
                    <label htmlFor={`setting-${field.key}`} className="text-[13px] text-gray-300">
                      {field.label}
                    </label>
                    {range && <span className="text-[13px] text-gray-400">{range}</span>}
                    {changed && (
                      <>
                        <span
                          role="img"
                          aria-label="changed from default"
                          title="Changed from the default"
                          className="text-blue-400"
                        >
                          ●
                        </span>
                        <button
                          type="button"
                          aria-label={`Reset ${field.label}`}
                          className="text-[13px] text-gray-400 hover:text-gray-200"
                          onClick={() => onReset(field.key)}
                        >
                          Reset
                        </button>
                      </>
                    )}
                  </div>
                  {field.type !== "bool" && (
                    <FieldInput
                      field={field}
                      value={value}
                      invalid={Boolean(error)}
                      describedBy={error ? `${helpId} ${errorId}` : helpId}
                      onChange={(next) => onChange(field.key, next)}
                    />
                  )}
                  <p id={helpId} className="sr-only">
                    {field.help}
                  </p>
                  {error && (
                    <p id={errorId} className="text-[13px] text-red-300">
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      ))}
    </div>
  );
}
