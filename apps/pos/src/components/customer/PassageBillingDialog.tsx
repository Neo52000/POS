import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { edge } from '@/lib/edge';
import { errorMessage } from '@/lib/utils';
import { useUiStore } from '@/stores/uiStore';
import type { PassageBilling } from '@/types/pos';

export interface PassageBillingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: { id: string; full_name: string };
  onSaved?: (billing: PassageBilling) => void;
}

const EMPTY = {
  name: '',
  address: '',
  postal_code: '',
  city: '',
  siret: '',
  vat_number: '',
  email: '',
};
type Form = typeof EMPTY;

const FIELDS: Array<{ key: keyof Form; label: string; max: number; span?: boolean; type?: string }> = [
  { key: 'name', label: 'Nom ou raison sociale *', max: 160, span: true },
  { key: 'address', label: 'Adresse *', max: 300, span: true },
  { key: 'postal_code', label: 'Code postal *', max: 16 },
  { key: 'city', label: 'Ville *', max: 100 },
  { key: 'siret', label: 'SIRET', max: 20 },
  { key: 'vat_number', label: 'N° de TVA', max: 20 },
  { key: 'email', label: 'E-mail (envoi de la facture)', max: 160, span: true, type: 'email' },
];

/** Champs indispensables pour émettre une facture. */
export function isBillingComplete(b: PassageBilling | null | undefined): boolean {
  return !!b?.name?.trim() && !!b.address?.trim() && !!b.postal_code?.trim() && !!b.city?.trim();
}

/**
 * En-tête de facture d'une personne de passage : nom / société, adresse, SIRET, TVA, e-mail.
 * Enregistré sur la fiche du contact (hors périmètre fiscal : le ticket NF525 est inchangé).
 * Indisponible hors ligne.
 */
export function PassageBillingDialog({
  open,
  onOpenChange,
  contact,
  onSaved,
}: PassageBillingDialogProps) {
  const offline = useUiStore((s) => s.connectivity === 'offline');
  const [form, setForm] = useState<Form>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setForm({ ...EMPTY, name: contact.full_name });
    if (offline) return;
    setLoading(true);
    edge
      .passageBillingGet(contact.id)
      .then((b) => {
        if (cancelled) return;
        setForm({ ...EMPTY, name: contact.full_name, ...b });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, contact.id, contact.full_name, offline]);

  const complete = isBillingComplete(form);

  const save = async (): Promise<void> => {
    if (!complete || saving || offline) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await edge.passageBillingSet(contact.id, form);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>En-tête de facture</DialogTitle>
          <DialogDescription>
            Coordonnées imprimées sur la facture de {contact.full_name}. Les champs * sont
            obligatoires.
          </DialogDescription>
        </DialogHeader>
        {offline && (
          <p className="text-warning" data-testid="billing-offline">
            Hors ligne : saisie de l&apos;en-tête indisponible.
          </p>
        )}
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {FIELDS.map((f) => (
            <label key={f.key} className={f.span ? 'sm:col-span-2' : undefined}>
              <span className="mb-1 block text-sm text-muted">{f.label}</span>
              <Input
                type={f.type ?? 'text'}
                value={form[f.key]}
                maxLength={f.max}
                disabled={offline || loading}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                data-testid={`billing-${f.key}`}
              />
            </label>
          ))}
          {error && <p className="text-sm text-danger sm:col-span-2">{error}</p>}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" size="touch" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button
              type="submit"
              size="touch"
              disabled={offline || loading || saving || !complete}
              data-testid="billing-save"
            >
              {(loading || saving) && <Loader2 className="h-5 w-5 animate-spin" />}
              Enregistrer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
