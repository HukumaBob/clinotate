interface ConfusionMatrixProps {
  labels: string[];
  matrix: number[][];
}

/** Rows are the reference (truth), columns the model's prediction; cells are shaded by count. */
export function ConfusionMatrix({ labels, matrix }: ConfusionMatrixProps) {
  const max = Math.max(1, ...matrix.flat());
  return (
    <div className="overflow-x-auto">
      <table aria-label="Confusion matrix" className="border-collapse text-xs text-gray-300">
        <thead>
          <tr>
            <th scope="col" className="px-1 py-0.5 text-left font-normal text-gray-500">truth ↓ / predicted →</th>
            {labels.map((l) => (
              <th key={l} scope="col" className="px-1 py-0.5 text-right font-medium">{l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, i) => (
            <tr key={labels[i]}>
              <th scope="row" className="px-1 py-0.5 text-left font-medium">{labels[i]}</th>
              {row.map((count, j) => (
                <td
                  key={labels[j]}
                  className="px-1 py-0.5 text-right tabular-nums"
                  style={{ backgroundColor: `rgba(59, 130, 246, ${(0.6 * count) / max})` }}
                >
                  {count}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
