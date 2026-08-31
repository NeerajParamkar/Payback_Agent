interface BarListItem {
  key: string;
  label: string;
  fraction: number; // 0-1, bar fill width
  valueLabel: string; // formatted value shown at the end of the row
  barClassName?: string; // override fill color, e.g. for a two-group comparison
}

export function BarList({ items }: { items: BarListItem[] }) {
  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div
          key={item.key}
          className="grid grid-cols-[minmax(0,13rem)_1fr_auto] items-center gap-3"
        >
          <span className="truncate text-sm text-foreground" title={item.label}>
            {item.label}
          </span>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${item.barClassName ?? "bg-brand-blue"}`}
              style={{
                width: `${Math.max(item.fraction * 100, item.fraction > 0 ? 3 : 0)}%`,
              }}
            />
          </div>
          <span className="whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">
            {item.valueLabel}
          </span>
        </div>
      ))}
    </div>
  );
}
