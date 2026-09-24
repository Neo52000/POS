import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, Download, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { describeApiError } from '@/lib/apiError';
import { edge } from '@/lib/edge';
import { formatDateTime } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { PosArchive } from '@/types/pos';

const monthFmt = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  month: 'long',
  year: 'numeric',
});

export const ARCHIVES_KEY = ['pos_archives'] as const;

async function fetchArchives(): Promise<PosArchive[]> {
  const { data, error } = await supabase
    .from('pos_archives')
    .select(
      'id, register_id, period_start, period_end, storage_path, manifest_sha256, hash, created_at',
    )
    .order('period_start', { ascending: false })
    .limit(120);
  if (error) throw new Error(error.message);
  return (data ?? []) as PosArchive[];
}

/** Archives NF525 (lot 5, admin) : liste, téléchargement (URL signée 5 min), génération. */
export function ArchivesSection() {
  const { isAdmin } = useIsAdmin();
  const register = useSessionStore((s) => s.register);
  const offline = useUiStore((s) => s.connectivity === 'offline');
  const toast = useUiStore((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);
  const archives = useQuery({
    queryKey: ARCHIVES_KEY,
    queryFn: fetchArchives,
    enabled: isAdmin,
    staleTime: 60_000,
  });

  if (!isAdmin) return null;

  const registerCode = (a: PosArchive): string =>
    a.register_id === register?.id ? register.code : (a.storage_path.split('/')[0] ?? '—');

  const download = async (a: PosArchive): Promise<void> => {
    setBusy(a.id);
    try {
      const { data, error } = await supabase.storage
        .from('pos-archives')
        .createSignedUrl(a.storage_path, 300);
      if (error || !data?.signedUrl) throw new Error(error?.message ?? 'URL signée indisponible');
      const link = document.createElement('a');
      link.href = data.signedUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.download = a.storage_path.split('/').pop() ?? 'archive.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (e) {
      toast({
        title: 'Téléchargement impossible',
        description: describeApiError(e),
        variant: 'danger',
      });
    } finally {
      setBusy(null);
    }
  };

  const generate = async (): Promise<void> => {
    setBusy('generate');
    try {
      const r = await edge.exportArchive({});
      const created = r.archives.filter((x) => !x.already_exists).length;
      const existing = r.archives.length - created;
      toast({
        title: `${created} archive(s) générée(s)`,
        description: existing ? `${existing} déjà existante(s)` : undefined,
        variant: 'success',
      });
      await archives.refetch();
    } catch (e) {
      toast({
        title: 'Génération impossible',
        description: describeApiError(e),
        variant: 'danger',
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-3xl border border-border bg-surface p-6 md:col-span-2"
      data-testid="archives-section"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Archive className="h-5 w-5 text-accent" />
        <h2 className="mr-auto text-xl font-semibold">Archives NF525</h2>
        <Button
          variant="ghost"
          size="touch"
          onClick={() => void archives.refetch()}
          aria-label="Rafraîchir"
        >
          <RefreshCw className={archives.isFetching ? 'h-5 w-5 animate-spin' : 'h-5 w-5'} />
        </Button>
        <Button
          size="touch"
          onClick={() => void generate()}
          disabled={busy !== null || offline}
          data-testid="archive-generate"
        >
          {busy === 'generate' ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
          Générer le mois précédent
        </Button>
      </div>
      <p className="text-sm text-muted">
        Export mensuel signé (chaîne de hash) généré automatiquement le 1er du mois. Les
        téléchargements utilisent un lien temporaire (5 minutes).
      </p>
      {archives.isError && <p className="text-danger">{describeApiError(archives.error)}</p>}
      <div className="overflow-x-auto rounded-2xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Période</TableHead>
              <TableHead>Caisse</TableHead>
              <TableHead>Manifeste (SHA-256)</TableHead>
              <TableHead>Hash</TableHead>
              <TableHead>Créée le</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(archives.data ?? []).map((a) => (
              <TableRow key={a.id} className="h-14" data-testid="archive-row">
                <TableCell className="font-medium capitalize">
                  {monthFmt.format(new Date(a.period_start))}
                </TableCell>
                <TableCell>{registerCode(a)}</TableCell>
                <TableCell className="font-mono text-xs" title={a.manifest_sha256}>
                  {a.manifest_sha256.slice(0, 12)}…
                </TableCell>
                <TableCell className="font-mono text-xs" title={a.hash}>
                  {a.hash.slice(0, 12)}…
                </TableCell>
                <TableCell>{formatDateTime(a.created_at)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="secondary"
                    size="touch"
                    onClick={() => void download(a)}
                    disabled={busy !== null || offline}
                    data-testid="archive-download"
                  >
                    {busy === a.id ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <Download className="h-5 w-5" />
                    )}
                    Télécharger
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {archives.data && archives.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted">
                  Aucune archive.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
