import { useState } from 'react';
import { Loader2, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { env } from '@/lib/env';
import { logEvent } from '@/lib/events';
import { supabase } from '@/lib/supabase';
import { errorMessage } from '@/lib/utils';

const AUTH_MESSAGES: Record<string, string> = {
  'Invalid login credentials': 'E-mail ou mot de passe incorrect.',
  'Email not confirmed': 'Adresse e-mail non confirmée.',
};

/** Connexion vendeur (Supabase Auth, projet Pos). */
export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    setPending(true);
    try {
      const { data, error: err } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (err) {
        setError(AUTH_MESSAGES[err.message] ?? err.message);
        return;
      }
      const { data: isPos, error: roleErr } = await supabase.rpc('is_pos');
      if (roleErr || isPos !== true) {
        await supabase.auth.signOut();
        setError(roleErr ? errorMessage(roleErr) : 'Ce compte n’a pas le rôle caisse (pos).');
        return;
      }
      void logEvent('login', {
        email: data.user?.email ?? email.trim(),
        app_version: env.appVersion,
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="touch-ui flex h-full items-center justify-center bg-bg p-6">
      <form
        className="flex w-full max-w-md flex-col gap-5 rounded-3xl border border-border bg-surface p-8"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div>
          <h1 className="text-3xl font-semibold">
            Ma Papeterie <span className="text-accent">POS</span>
          </h1>
          <p className="mt-1 text-sm text-muted">Connexion vendeur · v{env.appVersion}</p>
        </div>
        <label className="flex flex-col gap-1.5 text-sm text-muted">
          E-mail
          <Input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-16 text-xl"
            autoFocus
            required
            data-testid="login-email"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-muted">
          Mot de passe
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-16 text-xl"
            required
            data-testid="login-password"
          />
        </label>
        {error && (
          <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" size="pay" disabled={pending} data-testid="login-submit">
          {pending ? <Loader2 className="h-6 w-6 animate-spin" /> : <LogIn className="h-6 w-6" />}{' '}
          Se connecter
        </Button>
        {env.e2eMock && <p className="text-center text-xs text-warning">Mode mock (e2e) actif</p>}
      </form>
    </div>
  );
}
