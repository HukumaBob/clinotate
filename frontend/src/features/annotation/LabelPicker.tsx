import type { components } from "../../shared/api/generated/schema";

type Label = components["schemas"]["LabelRead"];

interface LabelPickerProps {
  labels: Label[];
  onSelect: (labelId: number) => void;
}

export function LabelPicker({ labels, onSelect }: LabelPickerProps) {
  return (
    <ul className="space-y-2">
      {labels.map((label) => (
        <li key={label.id}>
          <button
            type="button"
            onClick={() => onSelect(label.id)}
            className="flex w-full items-center gap-2 rounded border border-gray-700 bg-gray-800 px-3 py-2 text-left text-gray-100 hover:bg-gray-700"
          >
            <span
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: label.color }}
            />
            {label.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
