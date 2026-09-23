import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatEurCents } from '@/lib/format';

export const BILLS = [50000, 20000, 10000, 5000, 2000, 1000, 500] as const;
export const COINS = [200, 100, 50, 20, 10, 5, 2, 1] as const;

export type CashCounts = Record<number, number>;

export function cashCountTotal(counts: CashCounts): number {
  return Object.entries(counts).reduce((sum, [denom, n]) => sum + Number(denom) * (n || 0), 0);
}

export interface CashCountGridProps {
  counts: CashCounts;
  onChange: (counts: CashCounts) => void;
}

function Row({
  denom,
  count,
  onCount,
}: {
  denom: number;
  count: number;
  onCount: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-bg px-3 py-2">
      <span className="w-20 shrink-0 text-base font-medium tabular">{formatEurCents(denom)}</span>
      <Button
        variant="secondary"
        size="icon-touch"
        aria-label="Moins"
        onClick={() => onCount(Math.max(0, count - 1))}
      >
        −
      </Button>
      <Input
        value={count === 0 ? '' : String(count)}
        onChange={(e) =>
          onCount(Math.max(0, Math.floor(Number(e.target.value.replace(/\D/g, '')) || 0)))
        }
        inputMode="numeric"
        placeholder="0"
        className="h-12 w-20 text-center"
        aria-label={`Nombre de ${formatEurCents(denom)}`}
      />
      <Button
        variant="secondary"
        size="icon-touch"
        aria-label="Plus"
        onClick={() => onCount(count + 1)}
      >
        +
      </Button>
      <span className="ml-auto text-sm text-muted tabular">{formatEurCents(denom * count)}</span>
    </div>
  );
}

/** Grille de comptage billets / pièces. */
export function CashCountGrid({ counts, onChange }: CashCountGridProps) {
  const set = (denom: number, n: number): void => onChange({ ...counts, [denom]: n });
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-wide text-muted">Billets</p>
        {BILLS.map((d) => (
          <Row key={d} denom={d} count={counts[d] ?? 0} onCount={(n) => set(d, n)} />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-wide text-muted">Pièces</p>
        {COINS.map((d) => (
          <Row key={d} denom={d} count={counts[d] ?? 0} onCount={(n) => set(d, n)} />
        ))}
      </div>
    </div>
  );
}
