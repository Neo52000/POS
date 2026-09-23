import { useState } from 'react';
import { Building2, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useCustomerSearch } from '@/hooks/useCustomerSearch';
import { formatEurCents } from '@/lib/format';
import { errorMessage } from '@/lib/utils';
import type { PosCustomer } from '@/types/pos';

export interface CustomerSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (customer: PosCustomer) => void;
}

export function CustomerSearchDialog({ open, onOpenChange, onPick }: CustomerSearchDialogProps) {
  const [q, setQ] = useState('');
  const { data, isFetching, isError, error } = useCustomerSearch(open ? q : '');

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
          <DialogTitle>Client professionnel</DialogTitle>
          <DialogDescription>
            Nom, raison sociale ou SIRET (2 caractères minimum).
          </DialogDescription>
        </DialogHeader>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher un client…"
          autoFocus
          data-testid="customer-search-input"
        />
        <div className="min-h-[200px] flex-1 overflow-y-auto">
          {isFetching && (
            <div className="flex justify-center py-6 text-muted">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}
          {isError && <p className="py-4 text-center text-danger">{errorMessage(error)}</p>}
          {data && data.length === 0 && !isFetching && (
            <p className="py-6 text-center text-muted">Aucun client.</p>
          )}
          <ul className="flex flex-col gap-2">
            {(data ?? []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onPick(c)}
                  className="flex w-full items-start gap-3 rounded-xl border border-border bg-bg p-3 text-left hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  data-testid="customer-result"
                >
                  <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{c.display_name}</p>
                    <p className="truncate text-xs text-muted">
                      {[c.siret && `SIRET ${c.siret}`, c.email, c.phone]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {c.customer_type && <Badge variant="secondary">{c.customer_type}</Badge>}
                      {c.payment_terms_days ? (
                        <Badge variant="outline">Paiement à {c.payment_terms_days} j</Badge>
                      ) : null}
                      {c.pricing_rules_count > 0 && (
                        <Badge variant="success">
                          {c.pricing_rules_count} règle(s) tarifaire(s)
                        </Badge>
                      )}
                      {c.open_quotes_count > 0 && (
                        <Badge variant="warning">{c.open_quotes_count} devis ouvert(s)</Badge>
                      )}
                      {c.revenue_ttc_12m != null && (
                        <Badge variant="muted">
                          CA 12 m {formatEurCents(Math.round(c.revenue_ttc_12m * 100))}
                        </Badge>
                      )}
                    </div>
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
