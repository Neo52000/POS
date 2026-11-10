import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { PosProduct } from '@/types/pos';
import { ServiceShortcuts } from './ServiceShortcuts';

const p = (name: string, price_ttc_cents: number): PosProduct =>
  ({ id: name, name, price_ttc_cents, pos_price_tiers: null }) as unknown as PosProduct;

const products = [
  p('Photocopies A4 N&B', 25),
  p('Supplément reliure métal', 449),
  p('Plastification A4', 150),
];

describe('ServiceShortcuts', () => {
  it('ne rend rien sans prestation', () => {
    const { container } = render(<ServiceShortcuts products={[]} onPick={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('affiche la première famille, change d’onglet et ajoute la prestation touchée', () => {
    const onPick = vi.fn();
    render(<ServiceShortcuts products={products} onPick={onPick} />);
    expect(screen.getAllByTestId('service-tile')).toHaveLength(1);
    fireEvent.click(screen.getByText('Photocopies A4 N&B'));
    expect(onPick).toHaveBeenCalledWith(products[0]);

    fireEvent.click(screen.getByTestId('service-tab-Reliure'));
    expect(screen.getByText('Supplément reliure métal')).toBeInTheDocument();
    expect(screen.queryByText('Photocopies A4 N&B')).toBeNull();
    fireEvent.click(screen.getByText('Supplément reliure métal'));
    expect(onPick).toHaveBeenLastCalledWith(products[1]);
  });
});
