import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarCheck2,
  FileText,
  GraduationCap,
  Loader2,
  LockKeyhole,
  Printer,
} from 'lucide-react';
import { CLOSING_REPORT_KIND, formatReportPeriod } from '@pos/core';
import type { ReportPayload } from '@pos/core';
import { ReportPreview } from '@/components/ticket/ReportPreview';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePrinter } from '@/hooks/usePrinter';
import { useSession } from '@/hooks/useSession';
import { describeApiError, edge } from '@/lib/edge';
import { logEvent } from '@/lib/events';
import { formatDateTime, formatEurCents } from '@/lib/format';
import { closingReport, trainingXReport, xReport } from '@/lib/reports';
import { rpc, supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/sessionStore';
import { useTrainingStore } from '@/stores/trainingStore';
import { useUiStore } from '@/stores/uiStore';
import type { PosClosing, PosSession, XReportResult } from '@/types/pos';

type PeriodType = PosClosing['period_type'];
type Tab = 'x' | 'z1' | 'z2' | 'z3';

const TAB_PERIOD: Record<Exclude<Tab, 'x'>, PeriodType> = {
  z1: 'daily',
  z2: 'monthly',
  z3: 'annual',
};

const TABS: Array<{ value: Tab; label: string; hint: string }> = [
  { value: 'x', label: 'Lecture X', hint: 'en cours, sans remise à zéro' },
  { value: 'z1', label: 'Z1 · Jour', hint: 'clôture de session' },
  { value: 'z2', label: 'Z2 · Mois', hint: 'clôture mensuelle' },
  { value: 'z3', label: 'Z3 · Année', hint: 'clôture annuelle' },
];

/** Libellé de la période précédente (mois ou année écoulés, heure de Paris). */
function previousPeriodLabel(type: 'monthly' | 'annual', now = new Date()): string {
  const ref =
    type === 'monthly'
      ? new Date(now.getFullYear(), now.getMonth() - 1, 15)
      : new Date(now.getFullYear() - 1, 6, 1);
  return formatReportPeriod(type === 'monthly' ? 'Z2' : 'Z3', ref.toISOString(), null);
}

function ReportView({
  report,
  onPrint,
  printLabel,
}: {
  report: ReportPayload | null;
  onPrint: () => void;
  printLabel: string;
}) {
  if (!report) {
    return (
      <div className="flex h-full min-h-60 items-center justify-center rounded-2xl border border-dashed border-border p-6 text-center text-muted">
        Aucun rapport affiché.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Button size="touch" onClick={onPrint} data-testid="report-print">
        <Printer className="h-5 w-5" /> {printLabel}
      </Button>
      <ReportPreview report={report} />
    </div>
  );
}

function XPanel() {
  const session = useSessionStore((s) => s.session);
  const register = useSessionStore((s) => s.register);
  const user = useSessionStore((s) => s.user);
  const offline = useUiStore((s) => s.connectivity === 'offline');
  const toast = useUiStore((s) => s.toast);
  const training = useTrainingStore((s) => s.active);
  const trainingTickets = useTrainingStore((s) => s.tickets);
  const trainingStartedAt = useTrainingStore((s) => s.startedAt);
  const { printReport } = usePrinter();
  const [report, setReport] = useState<ReportPayload | null>(null);

  const read = useMutation({
    mutationFn: () => rpc<XReportResult>('pos_x_report', { p_session_id: session?.id }),
    onSuccess: (x) => setReport(xReport(x, user?.email)),
    onError: (e) =>
      toast({ title: 'Lecture X impossible', description: describeApiError(e), variant: 'danger' }),
  });

  const readTraining = (): void =>
    setReport(
      trainingXReport(trainingTickets, {
        registerCode: register?.code ?? '',
        startedAt: trainingStartedAt,
        operatorEmail: user?.email,
      }),
    );

  const blocked = training
    ? null
    : !session
      ? 'Aucune session ouverte : la lecture X porte sur la session en cours.'
      : offline
        ? 'Hors ligne : la lecture X est calculée par le serveur.'
        : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
      <div className="flex flex-col gap-4 rounded-3xl border border-border bg-surface p-6">
        <div>
          <h2 className="text-2xl font-semibold">Lecture X</h2>
          <p className="text-sm text-muted">
            État intermédiaire de la session en cours (chiffre d’affaires, TVA, règlements, espèces
            attendues) <strong>sans remise à zéro</strong>. Document non fiscal, tracé au journal :
            seul le Z fait foi.
          </p>
        </div>
        {training && (
          <p className="flex items-center gap-2 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">
            <GraduationCap className="h-4 w-4 shrink-0" /> Mode formation : lecture calculée sur les{' '}
            {trainingTickets.length} ticket(s) de formation du poste.
          </p>
        )}
        {blocked && (
          <p
            className="rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning"
            data-testid="x-blocked"
          >
            {blocked}
          </p>
        )}
        <Button
          size="pay"
          disabled={!!blocked || read.isPending}
          onClick={() => (training ? readTraining() : read.mutate())}
          data-testid="x-read"
        >
          {read.isPending ? (
            <Loader2 className="h-6 w-6 animate-spin" />
          ) : (
            <FileText className="h-6 w-6" />
          )}{' '}
          Éditer la lecture X
        </Button>
      </div>
      <ReportView
        report={report}
        onPrint={() => report && void printReport(report)}
        printLabel="Imprimer la lecture X"
      />
    </div>
  );
}

function ClosingsPanel({ type }: { type: PeriodType }) {
  const qc = useQueryClient();
  const register = useSessionStore((s) => s.register);
  const currentSession = useSessionStore((s) => s.session);
  const offline = useUiStore((s) => s.connectivity === 'offline');
  const toast = useUiStore((s) => s.toast);
  const training = useTrainingStore((s) => s.active);
  const { printReport } = usePrinter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const kind = CLOSING_REPORT_KIND[type];

  const closings = useQuery({
    queryKey: ['closings', register?.id, type],
    enabled: !!register,
    queryFn: async (): Promise<PosClosing[]> => {
      const { data, error } = await supabase
        .from('pos_closings')
        .select('*')
        .eq('register_id', register?.id ?? '')
        .eq('period_type', type)
        .order('closing_number', { ascending: false })
        .limit(60);
      if (error) throw new Error(error.message);
      return (data ?? []) as PosClosing[];
    },
  });
  const list = closings.data ?? [];
  const selected = list.find((c) => c.id === selectedId) ?? list[0] ?? null;

  // Z1 : fond de caisse, espèces comptées et écart viennent de la session clôturée.
  const session = useQuery({
    queryKey: ['session-by-id', selected?.session_id],
    enabled: !!selected?.session_id,
    queryFn: async (): Promise<PosSession | null> => {
      const { data, error } = await supabase
        .from('pos_sessions')
        .select('*')
        .eq('id', selected?.session_id ?? '')
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as PosSession | null) ?? null;
    },
  });

  const report = useMemo(
    () =>
      selected
        ? closingReport(selected, {
            registerCode: register?.code ?? '',
            session: session.data ?? currentSession,
            duplicate: true,
          })
        : null,
    [selected, register, session.data, currentSession],
  );

  const close = useMutation({
    mutationFn: () =>
      edge.closePeriod({
        register_id: register?.id ?? '',
        period_type: type === 'annual' ? 'annual' : 'monthly',
      }),
    onSuccess: async (r) => {
      const c = r.closings[0];
      await qc.invalidateQueries({ queryKey: ['closings', register?.id, type] });
      if (c) setSelectedId(c.id);
      toast({
        title: c?.already_exists
          ? `${kind} déjà établi (n°${c.closing_number})`
          : `${kind} n°${c?.closing_number ?? '?'} enregistré`,
        variant: 'success',
      });
    },
    onError: (e) =>
      toast({ title: `${kind} impossible`, description: describeApiError(e), variant: 'danger' }),
  });

  const reprint = (): void => {
    if (!report || !selected) return;
    void printReport(report);
    void logEvent('reprint', {
      document: 'closing',
      closing_id: selected.id,
      closing_number: selected.closing_number,
      period_type: selected.period_type,
    });
  };

  const periodLabel = type === 'daily' ? null : previousPeriodLabel(type);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
      <div className="flex min-h-0 flex-col gap-4 rounded-3xl border border-border bg-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold">
              {type === 'daily'
                ? 'Clôtures journalières'
                : type === 'monthly'
                  ? 'Clôtures mensuelles'
                  : 'Clôtures annuelles'}{' '}
              ({kind})
            </h2>
            <p className="text-sm text-muted">
              {type === 'daily'
                ? 'Un Z1 est établi à la clôture de chaque session (écran Caisse).'
                : `Agrège les Z1 de la période, chaînée et définitive. Établie automatiquement chaque nuit après la fin de la période ; bouton ci-contre pour l’établir sans attendre.`}
            </p>
          </div>
          {type === 'daily' ? (
            <Button asChild size="touch" variant="secondary">
              <Link to="/closing">
                <LockKeyhole className="h-5 w-5" /> Clôturer la journée
              </Link>
            </Button>
          ) : (
            <Button
              size="touch"
              disabled={training || offline || close.isPending || !register}
              onClick={() => close.mutate()}
              data-testid={`close-${type}`}
              title={training ? 'Indisponible en mode formation' : undefined}
            >
              {close.isPending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <CalendarCheck2 className="h-5 w-5" />
              )}{' '}
              Clôturer {periodLabel}
            </Button>
          )}
        </div>
        {closings.isLoading && <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted" />}
        {closings.isError && <p className="text-danger">{describeApiError(closings.error)}</p>}
        {closings.isSuccess && list.length === 0 && (
          <p className="text-muted" data-testid="closings-empty">
            Aucune clôture {kind} pour cette caisse.
          </p>
        )}
        <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto" data-testid="closings-list">
          {list.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelectedId(c.id)}
                className={cn(
                  'flex min-h-touch w-full items-center justify-between gap-4 rounded-xl border px-4 py-2 text-left',
                  selected?.id === c.id
                    ? 'border-accent bg-accent/10'
                    : 'border-border bg-bg hover:bg-border/40',
                )}
                data-testid="closing-item"
              >
                <span>
                  <span className="font-semibold">
                    {kind} n°{c.closing_number}
                  </span>{' '}
                  <span className="text-sm text-muted">
                    {type === 'daily'
                      ? formatDateTime(c.period_start)
                      : formatReportPeriod(kind, c.period_start, c.period_end)}{' '}
                    · {c.txn_count} ticket(s)
                  </span>
                </span>
                <span className="text-lg font-semibold tabular">
                  {formatEurCents(Number(c.total_ttc_cents))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <ReportView report={report} onPrint={reprint} printLabel="Réimprimer (duplicata)" />
    </div>
  );
}

/** Rapports de caisse : lecture X, clôtures Z1 (jour), Z2 (mois), Z3 (année). */
export function ReportsPage() {
  useSession();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = raw === 'z1' || raw === 'z2' || raw === 'z3' ? raw : 'x';

  return (
    <div className="h-full overflow-y-auto p-6" data-testid="reports-page">
      <Tabs
        value={tab}
        onValueChange={(v) => setParams({ tab: v }, { replace: true })}
        className="mx-auto flex w-full max-w-6xl flex-col gap-5"
      >
        <TabsList className="grid h-auto grid-cols-4 gap-1">
          {TABS.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              className="flex min-h-touch flex-col gap-0.5 py-2"
              data-testid={`report-tab-${t.value}`}
            >
              <span className="text-base font-semibold">{t.label}</span>
              <span className="text-xs text-muted">{t.hint}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="x">
          <XPanel />
        </TabsContent>
        {(['z1', 'z2', 'z3'] as const).map((t) => (
          <TabsContent key={t} value={t}>
            <ClosingsPanel type={TAB_PERIOD[t]} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
