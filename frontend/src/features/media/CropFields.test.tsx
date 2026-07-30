import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CropFields, type Crop } from "./CropFields";

function ControlledCropFields({ onChange }: { onChange: (crop: Crop) => void }) {
  const [crop, setCrop] = useState<Crop>({ left: 0, right: 0, top: 0, bottom: 0 });
  return (
    <CropFields
      crop={crop}
      onChange={(next) => {
        setCrop(next);
        onChange(next);
      }}
    />
  );
}

describe("CropFields", () => {
  it("renders four inputs with values from the crop prop", () => {
    render(<CropFields crop={{ left: 12, right: 8, top: 4, bottom: 6 }} onChange={vi.fn()} />);

    expect(screen.getByLabelText(/left %/i)).toHaveValue(12);
    expect(screen.getByLabelText(/right %/i)).toHaveValue(8);
    expect(screen.getByLabelText(/top %/i)).toHaveValue(4);
    expect(screen.getByLabelText(/bottom %/i)).toHaveValue(6);
  });

  it("calls onChange with the updated crop object when an input changes", async () => {
    const onChange = vi.fn();
    render(<ControlledCropFields onChange={onChange} />);

    await userEvent.clear(screen.getByLabelText(/left %/i));
    await userEvent.type(screen.getByLabelText(/left %/i), "20");

    expect(onChange).toHaveBeenLastCalledWith({ left: 20, right: 0, top: 0, bottom: 0 });
  });

  it("sets min=0 and max=100 on the crop inputs", () => {
    render(<CropFields crop={{ left: 0, right: 0, top: 0, bottom: 0 }} onChange={vi.fn()} />);

    expect(screen.getByLabelText(/left %/i)).toHaveAttribute("min", "0");
    expect(screen.getByLabelText(/left %/i)).toHaveAttribute("max", "100");
  });
});
