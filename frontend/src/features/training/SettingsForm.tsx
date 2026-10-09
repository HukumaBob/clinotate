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
}

const INPUT =
  "rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100 aria-[invalid=true]:border-red-600";

function FieldInput({
  field,
  value,
  invalid,
  onChange,
}: {
  field: SettingField;
  value: SettingValue;
  invalid: boolean;
  onChange: (value: SettingValue) => void;
}) {
  const id = `setting-${field.key}`;
  if (field.type === "bool") {
    return (
      <input
        id={id}
        type="checkbox"
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
      min={field.min ?? undefined}
      max={field.max ?? undefined}
      step={field.step ?? (field.type === "float" ? "any" : 1)}
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
    />
  );
}

export function SettingsForm({
  schema,
  values,
  errors,
  onChange,
  onReset,
  onApplyPreset,
}: SettingsFormProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-gray-400">Presets</span>
        <div className="flex flex-wrap gap-2">
          {schema.presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              title={preset.description}
              className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
              onClick={() => onApplyPreset(preset.id)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500">
          A preset fills the fields below; you can still change any of them.
        </p>
      </div>

      {schema.groups.map((group) => (
        <details
          key={group.id}
          open={group.id === "basic"}
          className="rounded border border-gray-800 bg-gray-950"
        >
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-gray-200">
            {group.label}
          </summary>
          <div className="flex flex-col gap-3 px-3 pb-3">
            {group.fields.map((field) => {
              const value = values[field.key] ?? null;
              const changed = isChanged(field, value);
              const error = errors[field.key];
              return (
                <div
                  key={field.key}
                  data-testid={`field-${field.key}`}
                  className="flex flex-col gap-1"
                >
                  <div className="flex items-center gap-2">
                    <label htmlFor={`setting-${field.key}`} className="text-xs text-gray-300">
                      {field.label}
                    </label>
                    {changed && (
                      <>
                        <span
                          aria-label="changed from default"
                          title="Changed from the default"
                          className="text-blue-400"
                        >
                          ●
                        </span>
                        <button
                          type="button"
                          className="text-xs text-gray-500 hover:text-gray-200"
                          onClick={() => onReset(field.key)}
                        >
                          Reset
                        </button>
                      </>
                    )}
                  </div>
                  <FieldInput
                    field={field}
                    value={value}
                    invalid={Boolean(error)}
                    onChange={(next) => onChange(field.key, next)}
                  />
                  <p className="text-xs text-gray-500">{field.help}</p>
                  {error && <p className="text-xs text-red-300">{error}</p>}
                </div>
              );
            })}
          </div>
        </details>
      ))}
    </div>
  );
}
