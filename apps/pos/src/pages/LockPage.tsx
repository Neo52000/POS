import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NumPad } from '@/components/ui/numpad';
import { logEvent } from '@/lib/events';
import { hasPin, verifyPin } from '@/lib/pin';
import { supabase } from '@/lib/supabase';
import { useCartStore } from '@/stores/cartStore';
import { useSessionStore } from '@/stores/sessionStore';

/** Écran de verrouillage : pavé PIN (PBKDF2 local). */
export function LockPage() {
  const navigate = useNavigate();
  const unlock = useSessionStore((s) => s.unlock);
  const locked = useSessionStore((s) => s.locked);
  const user = useSessionStore((s) => s.user);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!locked || !hasPin()) {
      unlock();
      navigate('/', { replace: true });
    }
  }, [locked, unlock, navigate]);

  useEffect(() => {
    if (pin.length < 4 || checking) return;
    let cancelled = false;
    setChecking(true);
    void verifyPin(pin).then((ok) => {
      if (cancelled) return;
      setChecking(false);
      if (ok) {
        unlock();
        navigate('/', { replace: true });
      } else if (pin.length >= 8) {
        setError('PIN incorrect');
        setPin('');
      }
    });
    return () => {
      cancelled = true;
    };
    // vérification à chaque frappe (4 à 8 chiffres)
  }, [pin]);

  const logout = async (): Promise<void> => {
    void logEvent('logout', { from: 'lock' });
    useCartStore.getState().clear('logout');
    await supabase.auth.signOut();
    unlock();
    navigate('/login', { replace: true });
  };

  return (
    <div className="touch-ui flex h-full flex-col items-center justify-center gap-6 bg-bg p-6">
      <Lock className="h-10 w-10 text-accent" />
      <div className="text-center">
        <p className="text-2xl font-semibold">Caisse verrouillée</p>
        <p className="text-sm text-muted">{user?.email}</p>
      </div>
      <div className="flex gap-3" aria-label="PIN saisi">
        {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
          <span
            key={i}
            className={`h-4 w-4 rounded-full ${i < pin.length ? 'bg-accent' : 'bg-border'}`}
          />
        ))}
      </div>
      {error && <p className="text-danger">{error}</p>}
      <NumPad
        className="w-72"
        onDigit={(d) => {
          setError(null);
          setPin((p) => (p.length < 8 ? p + d : p));
        }}
        onBackspace={() => setPin((p) => p.slice(0, -1))}
        onClear={() => setPin('')}
        disabled={checking}
      />
      <Button variant="ghost" size="touch" onClick={() => void logout()}>
        <LogOut className="h-5 w-5" /> Changer d’utilisateur
      </Button>
    </div>
  );
}
