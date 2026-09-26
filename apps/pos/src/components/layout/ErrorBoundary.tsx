import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface State {
  error: Error | null;
}

/**
 * Filet de sécurité : une erreur de rendu n'affiche jamais un écran blanc. Le panier et un
 * éventuel encaissement en cours sont persistés : recharger la page les restaure.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] erreur de rendu', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        className="flex h-full min-h-screen flex-col items-center justify-center gap-4 bg-bg p-8 text-center text-text"
        role="alert"
        data-testid="error-boundary"
      >
        <AlertTriangle className="h-12 w-12 text-warning" />
        <p className="text-2xl font-semibold">Un problème d’affichage est survenu</p>
        <p className="max-w-lg text-muted">
          Le panier et l’encaissement en cours sont conservés. Rechargez la caisse pour reprendre.
        </p>
        <p className="max-w-lg truncate text-xs text-muted">{this.state.error.message}</p>
        <Button size="touch" onClick={() => window.location.reload()}>
          Recharger la caisse
        </Button>
      </div>
    );
  }
}
