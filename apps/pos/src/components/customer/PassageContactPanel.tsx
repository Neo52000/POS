import { useState } from 'react';
import { Loader2, Phone, User, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePassageSearch } from '@/hooks/usePassageSearch';
import { edge } from '@/lib/edge';
import { errorMessage } from '@/lib/utils';
import type { PassageContact } from '@/types/pos';

export interface PassageContactPanelProps {
  offline: boolean;
  onPick: (contact: PassageContact) => void;
}

/**
 * Personne de passage (sans dossier client) : recherche par nom ou téléphone, ou création
 * nom + téléphone. Le ticket portera la fiche « Client passage » ; le contact suit le pont
 * contacts de passage (hors périmètre fiscal). Indisponible hors ligne.
 */
export function PassageContactPanel({ offline, onPick }: PassageContactPanelProps) {
  const [q, setQ] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const { data, isFetching, isError, error } = usePassageSearch(offline ? '' : q);

  const create = async (): Promise<void> => {
    if (!fullName.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const contact = await edge.passageCreate(fullName.trim(), phone.trim() || null);
      onPick(contact);
    } catch (e) {
      setCreateError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={offline ? 'Recherche indisponible hors ligne' : 'Nom ou téléphone (06 12…)'}
        disabled={offline}
        data-testid="passage-search-input"
      />
      <div className="min-h-[120px] overflow-y-auto">
        {isFetching && (
          <div className="flex justify-center py-4 text-muted">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
        {isError && <p className="py-3 text-center text-danger">{errorMessage(error)}</p>}
        {data && data.length === 0 && !isFetching && (
          <p className="py-4 text-center text-muted">Personne trouvée — créez-la ci-dessous.</p>
        )}
        <ul className="flex flex-col gap-2">
          {(data ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick(c)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-bg p-3 text-left hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                data-testid="passage-result"
              >
                <User className="h-5 w-5 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{c.full_name}</p>
                  {c.phone && (
                    <p className="flex items-center gap-1 text-xs text-muted">
                      <Phone className="h-3 w-3" /> {c.phone}
                    </p>
                  )}
                </div>
                {c.open_orders_count ? (
                  <Badge variant="warning">{c.open_orders_count} commande(s)</Badge>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <form
        className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Input
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="Nom *"
          maxLength={160}
          disabled={offline}
          aria-label="Nom de la personne de passage"
          data-testid="passage-name-input"
        />
        <Input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Téléphone"
          maxLength={40}
          disabled={offline}
          aria-label="Téléphone de la personne de passage"
          data-testid="passage-phone-input"
        />
        <Button
          type="submit"
          size="touch"
          disabled={offline || creating || !fullName.trim()}
          data-testid="passage-create"
        >
          {creating ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <UserPlus className="h-5 w-5" />
          )}
          Créer
        </Button>
        {createError && <p className="text-sm text-danger sm:col-span-3">{createError}</p>}
      </form>
    </div>
  );
}
