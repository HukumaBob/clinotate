// settingsLogic.test.ts
import { describe, expect, it } from "vitest";

import {
  allFields,
  applyPreset,
  changedSettings,
  defaultValues,
  isChanged,
  validateSettings,
} from "./settingsLogic";
import { settingsSchemaFixture as schema } from "./testFixtures";

describe("settingsLogic", () => {
  it("starts from the schema defaults, with null for an unset optional field", () => {
    const values = defaultValues(schema);

    expect(values.epochs).toBe(50);
    expect(values.optimizer).toBe("auto");
    expect(values.freeze).toBeNull();
  });

  it("a preset fills its values on top of the defaults, never on top of earlier edits", () => {
    const quick = applyPreset(schema, "quick_check");
    expect(quick.epochs).toBe(3);
    expect(quick.batch).toBe(4);
    expect(quick.imgsz).toBe(640);

    // applying another preset must not keep what the first one set
    const fineTune = applyPreset(schema, "fine_tune");
    expect(fineTune.epochs).toBe(50);
    expect(fineTune.batch).toBe(8);
    expect(fineTune.freeze).toBe(10);
    expect(fineTune.optimizer).toBe("AdamW");
  });

  it("the standard preset restores every default", () => {
    expect(applyPreset(schema, "standard")).toEqual(defaultValues(schema));
  });

  it("an unknown preset id leaves the defaults", () => {
    expect(applyPreset(schema, "nope")).toEqual(defaultValues(schema));
  });

  it("reports only the settings that differ from their defaults", () => {
    const values = { ...defaultValues(schema), epochs: 30, freeze: 10, optimizer: "auto" };

    expect(changedSettings(schema, values)).toEqual({ epochs: 30, freeze: 10 });
  });

  it("an empty optional field is never sent", () => {
    const values = { ...defaultValues(schema), freeze: null };

    expect(changedSettings(schema, values)).toEqual({});
    expect("freeze" in changedSettings(schema, values)).toBe(false);
  });

  it("isChanged compares against the field default, treating null and undefined alike", () => {
    const freeze = allFields(schema).find((f) => f.key === "freeze")!;
    expect(isChanged(freeze, null)).toBe(false);
    expect(isChanged(freeze, 10)).toBe(true);
  });

  it("validates ranges, whole numbers, steps and required fields", () => {
    const base = defaultValues(schema);

    expect(validateSettings(schema, base)).toEqual({});
    expect(validateSettings(schema, { ...base, epochs: 0 }).epochs).toMatch(/at least 1/);
    expect(validateSettings(schema, { ...base, epochs: 1001 }).epochs).toMatch(/at most 1000/);
    expect(validateSettings(schema, { ...base, epochs: 2.5 }).epochs).toMatch(/whole number/);
    expect(validateSettings(schema, { ...base, imgsz: 650 }).imgsz).toMatch(/multiple of 32/);
    expect(validateSettings(schema, { ...base, epochs: null }).epochs).toMatch(/required/i);
    expect(validateSettings(schema, { ...base, freeze: null })).toEqual({});
    expect(validateSettings(schema, { ...base, freeze: -1 }).freeze).toMatch(/at least 0/);
  });
});
