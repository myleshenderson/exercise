/**
 * Rounded TSS. An estimated value (decision 16, `isEstimatedTss`) gets an "est." suffix and a
 * dashed border. A missing TSS renders nothing.
 */
export function TssChip({ tss, estimated = false }: { tss: number | null | undefined; estimated?: boolean }) {
  if (typeof tss !== "number" || !Number.isFinite(tss)) return null;
  const border = estimated ? "border-dashed border-gray-400" : "border-solid border-gray-300";
  return (
    <span
      data-estimated={estimated ? "true" : "false"}
      title={estimated ? "Estimated TSS (no power or heart rate)" : "Training Stress Score"}
      className={`inline-block whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium tabular-nums text-gray-800 ${border}`}
    >
      {Math.round(tss)} TSS{estimated ? " est." : ""}
    </span>
  );
}
