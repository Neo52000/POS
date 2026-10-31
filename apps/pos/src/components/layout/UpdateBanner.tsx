import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePwaUpdateStore } from '@/stores/pwaUpdateStore';
import { useCartStore } from '@/stores/cartStore';

/**
 * Bandeau « Nouvelle version disponible » : la mise à jour ne s'applique qu'au clic, jamais
 * pendant un encaissement (panier verrouillé). Le panier en cours est conservé au rechargement.
 */
export function UpdateBanner() {
  const available = usePwaUpdateStore((s) => s.available);
  const apply = usePwaUpdateStore((s) => s.apply);
  const paying = useCartStore((s) => s.locked);
  if (!available) return null;
  return (
    <div
      className="flex h-11 shrink-0 items-center gap-3 bg-accent px-4 text-sm font-semibold text-on-accent"
      role="status"
      data-testid="update-banner"
    >
      <RefreshCw className="h-4 w-4" />
      Nouvelle version de la caisse disponible
      <span className="font-normal opacity-90">
        {paying ? '· à appliquer après l’encaissement' : '· le panier en cours est conservé'}
      </span>
      <Button
        size="sm"
        variant="secondary"
        className="ml-auto"
        disabled={paying}
        onClick={apply}
        data-testid="update-apply"
      >
        Mettre à jour
      </Button>
    </div>
  );
}
