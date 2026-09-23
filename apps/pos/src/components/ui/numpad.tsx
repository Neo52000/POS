import { Delete } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';

export interface NumPadProps {
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onClear?: () => void;
  /** Touche décimale (virgule) affichée si `true`. */
  decimal?: boolean;
  className?: string;
  disabled?: boolean;
}

/** Pavé numérique tactile (touches ≥ 56 px). */
export function NumPad({
  onDigit,
  onBackspace,
  onClear,
  decimal = false,
  className,
  disabled,
}: NumPadProps) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  return (
    <div
      className={cn('grid grid-cols-3 gap-2', className)}
      role="group"
      aria-label="Pavé numérique"
    >
      {keys.map((k) => (
        <Button
          key={k}
          type="button"
          variant="secondary"
          size="touch"
          className="text-2xl"
          disabled={disabled}
          onClick={() => onDigit(k)}
        >
          {k}
        </Button>
      ))}
      {decimal ? (
        <Button
          type="button"
          variant="secondary"
          size="touch"
          className="text-2xl"
          disabled={disabled}
          onClick={() => onDigit(',')}
        >
          ,
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="touch"
          disabled={disabled || !onClear}
          onClick={onClear}
          aria-label="Effacer"
        >
          C
        </Button>
      )}
      <Button
        type="button"
        variant="secondary"
        size="touch"
        className="text-2xl"
        disabled={disabled}
        onClick={() => onDigit('0')}
      >
        0
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="touch"
        disabled={disabled}
        onClick={onBackspace}
        aria-label="Retour arrière"
      >
        <Delete className="h-6 w-6" />
      </Button>
    </div>
  );
}
