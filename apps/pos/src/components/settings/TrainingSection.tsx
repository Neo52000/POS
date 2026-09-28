import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GraduationCap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { formatDateTime, formatEurCents } from '@/lib/format';
import { startTraining, stopTraining, trainingSwitchBlocker } from '@/lib/training';
import { useTrainingStore } from '@/stores/trainingStore';
import { useUiStore } from '@/stores/uiStore';

/** Entrée / sortie du mode formation (SPEC §13.3). */
export function TrainingSection() {
  const navigate = useNavigate();
  const active = useTrainingStore((s) => s.active);
  const startedAt = useTrainingStore((s) => s.startedAt);
  const tickets = useTrainingStore((s) => s.tickets);
  const toast = useUiStore((s) => s.toast);
  const [confirm, setConfirm] = useState(false);

  const start = (): void => {
    try {
      startTraining();
      toast({
        title: 'Mode formation activé',
        description: 'Aucune vente ne sera enregistrée ; le TPE est simulé.',
        variant: 'warning',
      });
      navigate('/');
    } catch (e) {
      toast({
        title: 'Mode formation impossible',
        description: e instanceof Error ? e.message : String(e),
        variant: 'danger',
      });
    }
  };

  const total = tickets.reduce((s, t) => s + t.total_ttc_cents, 0);

  return (
    <section
      className="flex flex-col gap-4 rounded-3xl border border-border bg-surface p-6"
      data-testid="training-section"
    >
      <div className="flex items-center gap-2">
        <GraduationCap className="h-6 w-6 text-warning" />
        <h2 className="text-xl font-semibold">Mode formation</h2>
      </div>
      <p className="text-sm text-muted">
        Caisse d’entraînement pour former un vendeur : ventes, remises, remboursements, tickets en
        attente et lecture X fonctionnent normalement, mais <strong>rien n’est enregistré</strong>{' '}
        (ni ticket fiscal, ni journal, ni stock), le TPE est simulé et chaque ticket imprimé porte
        la mention « FORMATION — sans valeur ». Seuls l’entrée et la sortie du mode, l’ouverture du
        tiroir et les duplicatas de tickets réels sont tracés au journal.
      </p>
      {active ? (
        <>
          <p className="rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">
            Actif depuis {startedAt ? formatDateTime(startedAt) : '—'} · {tickets.length} ticket(s)
            de formation · {formatEurCents(total)}
          </p>
          <Button
            variant="warning"
            size="touch"
            onClick={() => {
              stopTraining();
              toast({ title: 'Mode formation terminé', description: 'Retour à la caisse réelle.' });
            }}
            data-testid="training-stop"
          >
            Quitter le mode formation
          </Button>
        </>
      ) : (
        <Button
          variant="secondary"
          size="touch"
          onClick={() => {
            const blocker = trainingSwitchBlocker();
            if (blocker) {
              toast({
                title: 'Mode formation impossible',
                description: blocker,
                variant: 'danger',
              });
              return;
            }
            setConfirm(true);
          }}
          data-testid="training-start"
        >
          <GraduationCap className="h-5 w-5" /> Démarrer le mode formation
        </Button>
      )}
      <ConfirmDialog
        open={confirm}
        onCancel={() => setConfirm(false)}
        title="Démarrer le mode formation ?"
        description="Les ventes suivantes ne seront pas enregistrées et le TPE sera simulé jusqu’à la sortie du mode. Les tickets en attente réels sont mis de côté et restaurés à la sortie."
        confirmLabel="Démarrer la formation"
        onConfirm={() => {
          setConfirm(false);
          start();
        }}
      />
    </section>
  );
}
