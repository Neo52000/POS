import { useState } from 'react';
import { Building2, Loader2, User } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useOpenDocumentsSearch } from '@/hooks/useOpenDocumentsSearch';
import { formatEurCents } from '@/lib/format';
import { errorMessage } from '@/lib/utils';
import { useUiStore } from '@/stores/uiStore';
import type { OpenDocumentsOwner } from '@/types/pos';

export interface OrderLookupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Le vendeur choisit un client : l'appelant l'attache puis ouvre ses commandes / BL. */
  onPick: (owner: OpenDocumentsOwner) => void;
}

/**
 * Reprise directe d'une commande en caisse : tous les clients ayant des commandes ou BL à
 * encaisser, recherchables par n° de commande / BL, nom ou téléphone. Le choix d'un client
 * ouvre ses documents (sélection multiple, un seul ticket).
 */
export function OrderLookupDialog({ open, onOpenChange, onPick }: OrderLookupDialogProps) {
  const [q, setQ] = useState('');
  const offline = useUiStore((s) => s.connectivity === 'offline');
  const { data, isFetching, isError, error } = useOpenDocumentsSearch(q, open && !offline);
  const tooShort = q.trim().length === 1;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setQ('');
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl">
        <DialogHeader>
          <DialogTitle>Récupérer des commandes</DialogTitle>
          <DialogDescription>
            Clients ayant des commandes ou BL à encaisser. Recherche par n° de commande, nom ou
            téléphone ; choisissez le client pour cocher une ou plusieurs commandes.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={offline ? 'Recherche indisponible hors ligne' : 'N° de commande, nom…'}
          disabled={offline}
          autoFocus
          data-testid="order-lookup-input"
        />
        <div className="min-h-[200px] flex-1 overflow-y-auto">
          {offline && (
            <p className="py-4 text-center text-warning">
              Hors ligne : reprise de commande indisponible.
            </p>
          )}
          {isFetching && (
            <div className="flex justify-center py-6 text-muted">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}
          {isError && <p className="py-4 text-center text-danger">{errorMessage(error)}</p>}
          {tooShort && <p className="py-4 text-center text-muted">2 caractères minimum.</p>}
          {data && data.length === 0 && !isFetching && !tooShort && (
            <p className="py-6 text-center text-muted">
              {q.trim() ? 'Aucune commande à encaisser trouvée.' : 'Aucune commande à encaisser.'}
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {(data ?? []).map((o) => (
              <li key={`${o.account_id}/${o.passage_contact_id ?? ''}`}>
                <button
                  type="button"
                  onClick={() => onPick(o)}
                  className="flex w-full items-start gap-3 rounded-xl border border-border bg-bg p-3 text-left hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  data-testid="order-lookup-result"
                >
                  {o.owner_kind === 'passage' ? (
                    <User className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                  ) : (
                    <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {o.display_name}{' '}
                      {o.owner_kind === 'passage' && <Badge variant="secondary">Passage</Badge>}
                    </p>
                    <p className="text-xs text-muted">
                      {[
                        o.orders_count > 0 && `${o.orders_count} commande(s)`,
                        o.delivery_notes_count > 0 && `${o.delivery_notes_count} BL`,
                        `${formatEurCents(Math.round(o.open_ttc * 100))} TTC à encaisser`,
                        o.phone,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {o.order_numbers.slice(0, 5).join(' · ')}
                      {o.order_numbers.length > 5 ? ' …' : ''}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
