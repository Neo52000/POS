import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { useUiStore } from '@/stores/uiStore';
import type { ToastVariant } from '@/stores/uiStore';
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from './toast';

const ICONS: Record<ToastVariant, typeof Info> = {
  default: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
};

const ICON_COLORS: Record<ToastVariant, string> = {
  default: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

export function Toaster() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);
  return (
    <ToastProvider swipeDirection="right">
      {toasts.map((t) => {
        const Icon = ICONS[t.variant];
        return (
          <Toast
            key={t.id}
            variant={t.variant}
            duration={t.durationMs}
            onOpenChange={(open) => {
              if (!open) dismiss(t.id);
            }}
          >
            <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${ICON_COLORS[t.variant]}`} />
            <div className="grid gap-1">
              <ToastTitle>{t.title}</ToastTitle>
              {t.description && <ToastDescription>{t.description}</ToastDescription>}
            </div>
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
