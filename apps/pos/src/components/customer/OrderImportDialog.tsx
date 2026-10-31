import { useEffect, useMemo, useState } from 'react';
import { Layers, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCustomerDocuments } from '@/hooks/useCustomerDocuments';
import {
  addOpenDocumentsToCart,
  documentIdsInCart,
  documentItemUnitTtcCents,
  flattenOpenDocuments,
  openDocumentNumber,
  openDocumentTotalCents,
  preparedGroupDocuments,
  type OpenDocument,
} from '@/lib/documentImport';
import { formatEurCents } from '@/lib/format';
import { errorMessage } from '@/lib/utils';
import { useCartStore } from '@/stores/cartStore';
import { useCustomerStore } from '@/stores/customerStore';

export interface OrderImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Commandes et bons de livraison à encaisser du client appelé : cases à cocher, ajout au panier
 * courant (sans le vider). BL = lignes livrées non réglées ; commande = partie non livrée.
 */
export function OrderImportDialog({ open, onOpenChange }: OrderImportDialogProps) {
  const account = useCustomerStore((s) => s.account);
  const passageContact = useCustomerStore((s) => s.passageContact);
  const cartLines = useCartStore((s) => s.lines);
  const { data, isFetching, isError, error } = useCustomerDocuments(
    open && account ? account.id : null,
    passageContact?.id,
  );
  const docs = useMemo(() => flattenOpenDocuments(data), [data]);
  const inCart = useMemo(() => documentIdsInCart(cartLines), [cartLines]);
  const group = useMemo(() => preparedGroupDocuments(data), [data]);
  const [selected, setSelected] = useState<string[]>([]);

  // À l'ouverture : le lot préparé au back-office est présélectionné (documents pas déjà au panier).
  useEffect(() => {
    if (!open) return;
    setSelected(group ? group.docs.map((d) => d.doc.id).filter((id) => !inCart.has(id)) : []);
  }, [open, group]);

  const toggle = (id: string): void =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const picked = docs.filter((d) => selected.includes(d.doc.id) && !inCart.has(d.doc.id));
  const pickedTotal = picked.reduce((s, d) => s + openDocumentTotalCents(d), 0);
  const addable = docs.filter((d) => !inCart.has(d.doc.id));

  const addDocs = (list: OpenDocument[]): void => {
    if (!account || list.length === 0) return;
    addOpenDocumentsToCart(account.id, list);
    // Lot entièrement au panier : sa demande de facture suit (case pré-cochée au paiement).
    if (group?.invoiceRequested) {
      const now = documentIdsInCart(useCartStore.getState().lines);
      if (group.docs.every((d) => now.has(d.doc.id))) useCartStore.getState().setInvoiceHint(true);
    }
    onOpenChange(false);
  };
  const add = (): void => addDocs(picked);
  const groupPending = group ? group.docs.filter((d) => !inCart.has(d.doc.id)) : [];

  const holder = passageContact ? passageContact.full_name : account?.display_name;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl">
        <DialogHeader>
          <DialogTitle>Commandes et BL à encaisser · {holder}</DialogTitle>
          <DialogDescription>
            BL : lignes livrées non réglées. Commande : partie non encore livrée. Les documents
            cochés s’ajoutent au panier courant.
          </DialogDescription>
        </DialogHeader>
        {group && groupPending.length > 0 && (
          <div
            className="flex items-center justify-between gap-3 rounded-xl border border-accent bg-accent-soft p-3"
            data-testid="prepared-group"
          >
            <p className="text-sm">
              <span className="font-semibold">Lot préparé au back-office</span> ·{' '}
              {group.docs.length} document(s) ·{' '}
              {formatEurCents(group.docs.reduce((s, d) => s + openDocumentTotalCents(d), 0))} TTC
              {group.invoiceRequested ? ' · facture demandée' : ''}
            </p>
            <Button
              size="touch"
              onClick={() => addDocs(groupPending)}
              data-testid="import-prepared-group"
            >
              <Layers className="mr-2 h-4 w-4" />
              Encaisser le lot
            </Button>
          </div>
        )}
        <div className="min-h-[160px] flex-1 overflow-y-auto">
          {isFetching && (
            <div className="flex justify-center py-6 text-muted">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}
          {isError && <p className="py-4 text-center text-danger">{errorMessage(error)}</p>}
          {data && docs.length === 0 && (
            <p className="py-6 text-center text-muted">Aucune commande ni aucun BL à encaisser.</p>
          )}
          <ul className="flex flex-col gap-2">
            {docs.map((d) => (
              <DocumentRow
                key={d.doc.id}
                d={d}
                checked={selected.includes(d.doc.id)}
                alreadyInCart={inCart.has(d.doc.id)}
                onToggle={() => toggle(d.doc.id)}
              />
            ))}
          </ul>
        </div>
        {addable.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <Button
              variant="ghost"
              size="touch"
              onClick={() =>
                setSelected(selected.length === addable.length ? [] : addable.map((d) => d.doc.id))
              }
            >
              {selected.length === addable.length ? 'Tout décocher' : 'Tout cocher'}
            </Button>
            <Button
              size="touch"
              onClick={add}
              disabled={picked.length === 0}
              data-testid="import-documents"
            >
              Ajouter au panier ({picked.length}) · {formatEurCents(pickedTotal)}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DocumentRow({
  d,
  checked,
  alreadyInCart,
  onToggle,
}: {
  d: OpenDocument;
  checked: boolean;
  alreadyInCart: boolean;
  onToggle: () => void;
}) {
  const number = openDocumentNumber(d);
  const total = openDocumentTotalCents(d);
  const items = d.doc.items;
  return (
    <li
      className={`rounded-xl border border-border bg-bg p-3 ${alreadyInCart ? 'opacity-50' : ''}`}
    >
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-6 w-6 accent-accent"
          checked={checked || alreadyInCart}
          disabled={alreadyInCart}
          onChange={onToggle}
          aria-label={`Sélectionner ${number}`}
          data-testid={`document-${number}`}
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            <Badge variant={d.kind === 'delivery_note' ? 'success' : 'secondary'}>
              {d.kind === 'delivery_note' ? 'BL' : 'Cde'}
            </Badge>{' '}
            {number}
            {d.kind === 'delivery_note' && (
              <span className="text-xs text-muted"> · commande {d.doc.order_number}</span>
            )}
            {d.kind === 'order' && d.doc.origin === 'shopify' && (
              <Badge variant="outline" className="ml-1">
                web
              </Badge>
            )}
            {alreadyInCart && <span className="ml-2 text-xs text-muted">déjà dans le panier</span>}
          </p>
          <p className="text-xs text-muted">
            {new Date(d.doc.created_at).toLocaleDateString('fr-FR')} · {items.length} ligne(s) ·{' '}
            {formatEurCents(total)} TTC
            {d.kind === 'order' && d.doc.shipping_ttc
              ? ` (dont port ${formatEurCents(Math.round(d.doc.shipping_ttc * 100))})`
              : ''}
          </p>
          <ul className="mt-1 text-xs text-muted">
            {items.slice(0, 4).map((it) => (
              <li key={`${it.sales_order_line_id}/${it.delivery_note_line_id ?? ''}`}>
                {it.quantity} × {it.label} — {formatEurCents(documentItemUnitTtcCents(it))} TTC
              </li>
            ))}
            {items.length > 4 && <li>…</li>}
          </ul>
        </div>
      </label>
    </li>
  );
}
