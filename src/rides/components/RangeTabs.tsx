export interface RangeTabOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** A segmented control (range, tab or unit toggle). */
export function RangeTabs<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly RangeTabOption<T>[];
  value: T;
  onChange(value: T): void;
  ariaLabel: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="inline-flex rounded-lg bg-gray-100 p-0.5 text-sm">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-3 py-1 ${selected ? "bg-white font-medium shadow-sm" : "text-gray-600"} disabled:opacity-40`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
