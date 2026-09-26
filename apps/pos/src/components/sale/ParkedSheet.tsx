import { useState } from 'react';
import { PlayCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatEurCents } from '@/lib/format';
import { MAX_PARKED, useParkedStore } from '@/stores/parkedStore';
import type { ParkedCart } from '@/stores/parkedStore';

export interface ParkedSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Panier courant non vide : il sera mis en attente à la place du panier rappelé. */
  currentLines: number;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** Tickets en attente : rappel (échange avec le panier courant) ou suppression tracée. */
export function ParkedSheet({ open, onOpenChange, currentLines }: ParkedSheetProps) {
  const parked = useParkedStore((s) => s.parked);
  const recall = useParkedStore((s) => s.recall);
  const discard = useParkedStore((s) => s.discard);
  const [toDiscard, setToDiscard] = useState<ParkedCart | null>(null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex flex-col gap-4 sm:max-w-md"
        data-testid="parked-sheet"
      >
        <SheetHeader>
          <SheetTitle>Tickets en attente</SheetTitle>
          <SheetDescription>
            {parked.length}/{MAX_PARKED}
            {currentLines > 0 && parked.length > 0
              ? ' · le panier en cours sera mis en attente à la place'
              : ''}
          </SheetDescription>
        </SheetHeader>
        {parked.length === 0 && (
          <p className="py-8 text-center text-muted">Aucun ticket en attente.</p>
        )}
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {[...parked].reverse().map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-bg p-3"
              data-testid="parked-item"
            >
              <div className="min-w-0 flex-1">
                <p className="text-lg font-semibold tabular">{formatEurCents(p.total_ttc_cents)}</p>
                <p className="truncate text-xs text-muted">
                  {timeOf(p.parked_at)} · {p.lines.length} ligne(s)
                  {p.account ? ` · ${p.account.display_name}` : ''}
                </p>
                <p className="truncate text-xs text-muted">
                  {p.lines
                    .slice(0, 3)
                    .map((l) => l.label)
                    .join(', ')}
                  {p.lines.length > 3 ? '…' : ''}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-touch"
                aria-label="Supprimer le ticket en attente"
                onClick={() => setToDiscard(p)}
              >
                <Trash2 className="h-5 w-5 text-danger" />
              </Button>
              <Button
                size="touch"
                onClick={() => {
                  if (recall(p.id)) onOpenChange(false);
                }}
                data-testid="recall-parked"
              >
                <PlayCircle className="h-5 w-5" /> Rappeler
              </Button>
            </li>
          ))}
        </ul>
        <ConfirmDialog
          open={toDiscard !== null}
          title="Supprimer ce ticket en attente ?"
          description={
            toDiscard
              ? `${toDiscard.lines.length} ligne(s) · ${formatEurCents(toDiscard.total_ttc_cents)}. La suppression est tracée au journal.`
              : undefined
          }
          confirmLabel="Supprimer"
          danger
          onCancel={() => setToDiscard(null)}
          onConfirm={() => {
            if (toDiscard) discard(toDiscard.id);
            setToDiscard(null);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}
