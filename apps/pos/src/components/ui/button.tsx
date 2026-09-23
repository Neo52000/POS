import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium transition-colors select-none active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  {
    variants: {
      variant: {
        default: 'bg-accent text-white hover:bg-accent-hover',
        secondary: 'bg-surface border border-border text-text hover:bg-border/60',
        outline: 'border border-border bg-transparent text-text hover:bg-surface',
        ghost: 'bg-transparent text-text hover:bg-surface',
        success: 'bg-success text-bg hover:bg-success/90',
        warning: 'bg-warning text-bg hover:bg-warning/90',
        danger: 'bg-danger text-white hover:bg-danger/90',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-10 px-3 text-sm',
        default: 'h-12 px-4 text-base',
        touch: 'min-h-touch px-5 text-lg',
        pay: 'min-h-pay px-6 text-xl font-semibold',
        icon: 'h-12 w-12',
        'icon-touch': 'min-h-touch min-w-touch',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        type={asChild ? undefined : (type ?? 'button')}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
