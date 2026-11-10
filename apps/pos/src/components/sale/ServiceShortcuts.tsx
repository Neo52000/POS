import { useMemo, useState } from 'react';
import { ConciergeBell } from 'lucide-react';
import { formatEurCents } from '@/lib/format';
import { groupServices } from '@/lib/serviceGroups';
import { cn } from '@/lib/utils';
import type { PosProduct } from '@/types/pos';

export interface ServiceShortcutsProps {
  products: PosProduct[] | undefined;
  onPick: (product: PosProduct) => void;
}

/**
 * Accès direct aux prestations (copies, impression, numérisation, plastification, reliure,
 * photos, grand format) : familles en onglets, prestations en grosses touches. Un multiplicateur
 * « 50* » saisi dans la recherche s'applique à la touche.
 */
export function ServiceShortcuts({ products, onPick }: ServiceShortcutsProps) {
  const groups = useMemo(() => groupServices(products ?? []), [products]);
  const [selected, setSelected] = useState<string | null>(null);
  if (groups.length === 0) return null;
  const current = groups.find((g) => g.group === selected) ?? groups[0]!;

  return (
    <div
      className="flex shrink-0 flex-col gap-2 rounded-2xl border border-border bg-surface p-2"
      data-testid="service-shortcuts"
    >
      <div className="flex items-center gap-2">
        <span className="flex shrink-0 items-center gap-1.5 px-1 text-xs uppercase tracking-wide text-muted">
          <ConciergeBell className="h-4 w-4" /> Services
        </span>
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto" role="tablist">
          {groups.map(({ group }) => (
            <button
              key={group}
              type="button"
              role="tab"
              aria-selected={group === current.group}
              onClick={() => setSelected(group)}
              className={cn(
                'h-11 shrink-0 rounded-xl px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                group === current.group
                  ? 'bg-accent text-on-accent'
                  : 'bg-bg text-text hover:border-accent',
              )}
              data-testid={`service-tab-${group}`}
            >
              {group}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1" data-testid="service-tiles">
        {current.products.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p)}
            className="flex min-h-[68px] w-[150px] shrink-0 flex-col justify-between rounded-xl border border-border bg-bg p-2 text-left hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:scale-[0.98]"
            data-testid="service-tile"
          >
            <span className="line-clamp-2 text-sm font-medium leading-tight">{p.name}</span>
            <span className="text-base font-semibold tabular">
              {Array.isArray(p.pos_price_tiers) && p.pos_price_tiers.length > 0
                ? 'Prix au choix'
                : formatEurCents(p.price_ttc_cents)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
