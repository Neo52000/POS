import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CreditCard, KeyRound, LogOut, Printer, RefreshCw } from 'lucide-react';
import type { TicketPayload } from '@pos/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { useBridgeHealth } from '@/hooks/useBridgeHealth';
import { bridge } from '@/lib/bridge';
import { env } from '@/lib/env';
import { logEvent } from '@/lib/events';
import { clearPin, hasPin, isValidPinFormat, setPin } from '@/lib/pin';
import { supabase } from '@/lib/supabase';
import { uuidv4 } from '@/lib/uuid';
import { errorMessage } from '@/lib/utils';
import { useCartStore } from '@/stores/cartStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

function testTicket(registerCode: string): TicketPayload {
  return {
    version: 1,
    register_code: registerCode,
    ticket_number: null,
    ticket_code: 'TEST',
    duplicate: false,
    kind: 'sale',
    business_at: new Date().toISOString(),
    cashier_name: 'Test',
    header: {
      company_name: 'Ma Papeterie',
      address_lines: ['Test imprimante'],
      siret: '',
      vat_number: '',
    },
    lines: [
      {
        label: 'Ticket de test',
        qty: 1,
        unit_price_ttc_cents: 0,
        discount_percent: 0,
        line_ttc_cents: 0,
        vat_rate: '20.00',
      },
    ],
    vat_breakdown: [],
    total_ht_cents: 0,
    total_vat_cents: 0,
    total_ttc_cents: 0,
    payments: [],
    change_cents: 0,
    footer: { lines: ['Impression OK'] },
    compliance: {
      hash_short: '00000000',
      signature_status: 'mock',
      software: 'Ma Papeterie POS',
      version: env.appVersion,
    },
    invoice_requested: false,
  };
}

/** Réglages du poste : pont TPE, tests matériels, PIN, déconnexion, infos. */
export function SettingsPage() {
  const navigate = useNavigate();
  const settings = useSettingsStore();
  const health = useBridgeHealth(true);
  const toast = useUiStore((s) => s.toast);
  const bridgeStatus = useUiStore((s) => s.bridgeStatus);
  const register = useSessionStore((s) => s.register);
  const session = useSessionStore((s) => s.session);
  const user = useSessionStore((s) => s.user);
  const [url, setUrl] = useState(settings.bridgeUrl);
  const [token, setToken] = useState(settings.bridgeToken);
  const [autoLock, setAutoLock] = useState(String(settings.autoLockMinutes));
  const [pin1, setPin1] = useState('');
  const [pin2, setPin2] = useState('');
  const [pinDefined, setPinDefined] = useState(hasPin());
  const [tpeResult, setTpeResult] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const saveBridge = (): void => {
    settings.update({
      bridgeUrl: url.trim().replace(/\/+$/, '') || env.bridgeUrlDefault,
      bridgeToken: token.trim(),
      autoLockMinutes: Math.max(0, Number(autoLock) || 0),
    });
    toast({ title: 'Réglages enregistrés', variant: 'success' });
    void health.refetch();
  };

  const testPrinter = async (): Promise<void> => {
    setBusy('print');
    try {
      const r = await bridge.print(testTicket(register?.code ?? ''));
      toast({
        title: r.ok ? 'Ticket de test envoyé' : 'Impression refusée',
        variant: r.ok ? 'success' : 'danger',
      });
    } catch (e) {
      toast({ title: 'Impression impossible', description: errorMessage(e), variant: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const testTpe = async (): Promise<void> => {
    setBusy('tpe');
    setTpeResult(null);
    try {
      const r = await bridge.pay({ txn_id: `test-${uuidv4()}`, amount_cents: 1, kind: 'debit' });
      setTpeResult(`${r.status}${r.code ? ` (code ${r.code})` : ''} · ${r.duration_ms} ms`);
      toast({
        title: `Test TPE : ${r.status}`,
        variant: r.status === 'approved' ? 'success' : 'warning',
      });
    } catch (e) {
      setTpeResult(errorMessage(e));
      toast({ title: 'Test TPE impossible', description: errorMessage(e), variant: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const savePin = async (): Promise<void> => {
    if (!isValidPinFormat(pin1)) {
      toast({ title: 'PIN invalide', description: '4 à 8 chiffres', variant: 'warning' });
      return;
    }
    if (pin1 !== pin2) {
      toast({ title: 'Les deux PIN diffèrent', variant: 'warning' });
      return;
    }
    await setPin(pin1);
    setPinDefined(true);
    setPin1('');
    setPin2('');
    toast({ title: 'PIN défini', variant: 'success' });
  };

  const logout = async (): Promise<void> => {
    void logEvent('logout', { from: 'settings' });
    useCartStore.getState().clear('logout');
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="h-full overflow-y-auto p-6" data-testid="settings-page">
      <div className="mx-auto grid w-full max-w-5xl gap-6 md:grid-cols-2">
        <section className="flex flex-col gap-4 rounded-3xl border border-border bg-surface p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Pont TPE / imprimante</h2>
            <Badge
              variant={
                bridgeStatus === 'ok' ? 'success' : bridgeStatus === 'ko' ? 'danger' : 'muted'
              }
            >
              {bridgeStatus === 'ok'
                ? `OK · v${health.data?.version ?? '?'}`
                : bridgeStatus === 'ko'
                  ? 'Injoignable'
                  : '…'}
            </Badge>
          </div>
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            URL du pont
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:8787"
              data-testid="bridge-url"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            Jeton (X-Bridge-Token)
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              autoComplete="off"
              data-testid="bridge-token"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            Verrouillage automatique (minutes, 0 = jamais)
            <Input
              value={autoLock}
              onChange={(e) => setAutoLock(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="touch" onClick={saveBridge}>
              Enregistrer
            </Button>
            <Button variant="secondary" size="touch" onClick={() => void health.refetch()}>
              <RefreshCw className="h-5 w-5" /> Tester la connexion
            </Button>
          </div>
          {health.data && (
            <p className="text-sm text-muted">
              TPE {health.data.tpe.reachable ? 'joignable' : 'injoignable'} · imprimante{' '}
              {health.data.printer.type}{' '}
              {health.data.printer.reachable ? 'joignable' : 'injoignable'}
              {health.data.simulate ? ' · mode simulation' : ''}
            </p>
          )}
          <Separator />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="touch"
              onClick={() => void testPrinter()}
              disabled={busy !== null}
            >
              <Printer className="h-5 w-5" /> Test imprimante
            </Button>
            <Button
              variant="secondary"
              size="touch"
              onClick={() => void testTpe()}
              disabled={busy !== null}
            >
              <CreditCard className="h-5 w-5" /> Test TPE (0,01 € simulé)
            </Button>
          </div>
          {tpeResult && <p className="text-sm text-muted">Résultat TPE : {tpeResult}</p>}
        </section>

        <section className="flex flex-col gap-4 rounded-3xl border border-border bg-surface p-6">
          <h2 className="text-xl font-semibold">PIN de verrouillage</h2>
          <p className="text-sm text-muted">
            {pinDefined
              ? 'Un PIN est défini sur ce poste.'
              : 'Aucun PIN : le verrouillage est désactivé.'}{' '}
            Le PIN ne remplace pas le mot de passe Supabase.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              type="password"
              inputMode="numeric"
              value={pin1}
              onChange={(e) => setPin1(e.target.value.replace(/\D/g, ''))}
              placeholder="Nouveau PIN"
              data-testid="pin-1"
            />
            <Input
              type="password"
              inputMode="numeric"
              value={pin2}
              onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))}
              placeholder="Confirmer"
              data-testid="pin-2"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="touch"
              onClick={() => void savePin()}
              disabled={!pin1 || !pin2}
              data-testid="pin-save"
            >
              <KeyRound className="h-5 w-5" /> Définir le PIN
            </Button>
            {pinDefined && (
              <Button
                variant="ghost"
                size="touch"
                onClick={() => {
                  clearPin();
                  setPinDefined(false);
                  toast({ title: 'PIN supprimé' });
                }}
              >
                Supprimer le PIN
              </Button>
            )}
          </div>
          <Separator />
          <h2 className="text-xl font-semibold">Poste</h2>
          <dl className="grid grid-cols-[160px_1fr] gap-y-1.5 text-sm">
            <dt className="text-muted">Version</dt>
            <dd>Ma Papeterie POS v{env.appVersion}</dd>
            <dt className="text-muted">Caisse</dt>
            <dd>{register ? `${register.code} — ${register.label ?? ''}` : '—'}</dd>
            <dt className="text-muted">Session</dt>
            <dd>{session ? `n°${session.session_number} (ouverte)` : 'aucune'}</dd>
            <dt className="text-muted">Vendeur</dt>
            <dd>{user?.email ?? '—'}</dd>
            <dt className="text-muted">Projet Pos</dt>
            <dd className="truncate">{env.supabaseUrl || (env.e2eMock ? 'mock' : '—')}</dd>
            <dt className="text-muted">Catalogue</dt>
            <dd className="truncate">{env.catalogUrl || (env.e2eMock ? 'mock' : '—')}</dd>
          </dl>
          <Separator />
          <Button variant="danger" size="touch" onClick={() => void logout()} data-testid="logout">
            <LogOut className="h-5 w-5" /> Se déconnecter
          </Button>
        </section>
      </div>
    </div>
  );
}
