// settingsLogic.ts
import type { components } from "../../shared/api/generated/schema";

export type SettingsSchema = components["schemas"]["SettingsSchemaRead"];
export type SettingField = components["schemas"]["SettingFieldRead"];
export type SettingValue = number | boolean | string | null;
export type SettingsValues = Record<string, SettingValue>;

export function allFields(schema: SettingsSchema): SettingField[] {
  return schema.groups.flatMap((group) => group.fields);
}

export function defaultValues(schema: SettingsSchema): SettingsValues {
  const values: SettingsValues = {};
  for (const field of allFields(schema)) {
    values[field.key] = field.default ?? null;
  }
  return values;
}

/** A preset is a set of changes against the defaults, so applying one starts
 * from the defaults: nothing a previous preset or a hand edit set can leak in. */
export function applyPreset(schema: SettingsSchema, presetId: string): SettingsValues {
  const values = defaultValues(schema);
  const preset = schema.presets.find((candidate) => candidate.id === presetId);
  if (preset) {
    for (const [key, value] of Object.entries(preset.values)) {
      if (key in values) {
        values[key] = value;
      }
    }
  }
  return values;
}

export function isChanged(field: SettingField, value: SettingValue | undefined): boolean {
  return (value ?? null) !== (field.default ?? null);
}

/** Only what differs from the defaults: smaller request, and the run's stored
 * configuration is completed from the backend's defaults. An empty optional
 * field is left out entirely (never "" or 0). */
export function changedSettings(
  schema: SettingsSchema,
  values: SettingsValues,
): Record<string, number | boolean | string> {
  const changed: Record<string, number | boolean | string> = {};
  for (const field of allFields(schema)) {
    const value = values[field.key];
    if (value !== null && value !== undefined && isChanged(field, value)) {
      changed[field.key] = value;
    }
  }
  return changed;
}

function formatLimit(value: number): string {
  return String(value);
}

export function validateSettings(
  schema: SettingsSchema,
  values: SettingsValues,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of allFields(schema)) {
    const value = values[field.key] ?? null;
    if (value === null) {
      if (!field.optional) {
        errors[field.key] = "Required";
      }
      continue;
    }
    if (field.type !== "int" && field.type !== "float") {
      continue;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      errors[field.key] = "Must be a number";
    } else if (field.type === "int" && !Number.isInteger(number)) {
      errors[field.key] = "Must be a whole number";
    } else if (field.type === "int" && field.step && field.step > 1 && number % field.step !== 0) {
      errors[field.key] = `Must be a multiple of ${field.step}`;
    } else if (field.min !== null && field.min !== undefined && number < field.min) {
      errors[field.key] = `Must be at least ${formatLimit(field.min)}`;
    } else if (field.max !== null && field.max !== undefined && number > field.max) {
      errors[field.key] = `Must be at most ${formatLimit(field.max)}`;
    }
  }
  return errors;
}
