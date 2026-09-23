import { Building2, FileText, Loader2, UserPlus, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCustomerStore } from '@/stores/customerStore';

export interface CustomerBadgeProps {
  onSearch: () => void;
  onQuotes: () => void;
}

/** Client pro attaché (ou bouton « Client pro »). */
export function CustomerBadge({ onSearch, onQuotes }: CustomerBadgeProps) {
  const account = useCustomerStore((s) => s.account);
  const resolving = useCustomerStore((s) => s.resolving);
  const error = useCustomerStore((s) => s.error);
  const detach = useCustomerStore((s) => s.detach);

  if (!account) {
    return (
      <div className="p-3">
        <Button
          variant="secondary"
          size="touch"
          className="w-full justify-start"
          onClick={onSearch}
          data-testid="customer-button"
        >
          <UserPlus className="h-5 w-5 text-accent" /> Client pro
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="customer-badge">
      <div className="flex items-start gap-2">
        <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{account.display_name}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {account.customer_type && <Badge variant="secondary">{account.customer_type}</Badge>}
            {account.pricing_rules_count > 0 && (
              <Badge variant="success">
                {account.pricing_rules_count} tarif{account.pricing_rules_count > 1 ? 's' : ''} pro
              </Badge>
            )}
            {account.payment_terms_days ? (
              <Badge variant="outline">{account.payment_terms_days} j</Badge>
            ) : null}
            {resolving && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
          </div>
          {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        </div>
        <Button variant="ghost" size="icon-touch" aria-label="Détacher le client" onClick={detach}>
          <X className="h-5 w-5" />
        </Button>
      </div>
      {account.open_quotes_count > 0 && (
        <Button
          variant="outline"
          size="touch"
          className="justify-start"
          onClick={onQuotes}
          data-testid="quotes-button"
        >
          <FileText className="h-5 w-5" /> {account.open_quotes_count} devis ouvert
          {account.open_quotes_count > 1 ? 's' : ''}
        </Button>
      )}
    </div>
  );
}
