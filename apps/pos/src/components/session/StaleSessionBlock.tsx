import { Link } from 'react-router-dom';
import { CalendarX2, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';

/**
 * Écran bloquant (0.4.0, lot 2) : la session ouverte date d'un jour précédent. Le serveur refuse
 * toute vente (`SESSION_STALE`) : le Z1 de la veille doit être établi avant tout encaissement.
 */
export function StaleSessionBlock({
  sessionNumber,
  openedAt,
}: {
  sessionNumber: number;
  openedAt: string;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="session-stale-block">
      <div
        className="flex w-full max-w-xl flex-col items-center gap-5 rounded-3xl border border-danger/50 bg-surface p-8 text-center"
        role="alert"
      >
        <CalendarX2 className="h-14 w-14 text-danger" />
        <h2 className="text-2xl font-semibold">Clôture Z de la veille obligatoire</h2>
        <p className="text-muted">
          La session n°{sessionNumber} a été ouverte le {formatDateTime(openedAt)}, un jour
          précédent. Aucune vente n’est possible avant sa clôture (Z). Comptez le tiroir, clôturez,
          puis ouvrez une nouvelle session.
        </p>
        <Button asChild variant="danger" size="pay">
          <Link to="/closing" data-testid="session-stale-close">
            <LockKeyhole className="h-6 w-6" /> Clôturer la session
          </Link>
        </Button>
      </div>
    </div>
  );
}
