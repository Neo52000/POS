import { describe, expect, it } from 'vitest';
import type { PosProduct } from '@/types/pos';
import { groupServices, serviceGroupOf } from './serviceGroups';

const p = (name: string, price_ttc_cents: number): PosProduct =>
  ({ id: name, name, price_ttc_cents }) as unknown as PosProduct;

describe('serviceGroupOf', () => {
  it.each([
    ['Photocopies A4 N&B', 'Copies & impression'],
    ['Abonnement Copies Couleur', 'Copies & impression'],
    ['Impression A4 Couleur', 'Copies & impression'],
    ['Numérisation au chargeur', 'Numérisation'],
    ['Plastification A3', 'Plastification'],
    ['Supplément reliure métal', 'Reliure'],
    ['Photo grand format A0', 'Photos'],
    ['Photos 10*15 satiné', 'Photos'],
    ['Photo tirage 10x15 cm', 'Photos'],
    ['Tampon personnalisé Trodat Printy 4912', 'Tampons'],
    ["Reliure spirale (jusqu'à 100 pages)", 'Reliure'],
    ['Impression bâche', 'Grand format'],
    ['Plan grand format A1', 'Grand format'],
    ['Affiche grand format A2', 'Grand format'],
    ['Flyers A5 Recto', 'Grand format'],
    ['Supplément papier couché', 'Autres services'],
  ])('%s → %s', (name, group) => {
    expect(serviceGroupOf(name)).toBe(group);
  });
});

describe('groupServices', () => {
  it('ordre fixe des familles, vides omises, tri par prix', () => {
    const g = groupServices([
      p('Supplément reliure métal', 449),
      p('Photocopies A4 N&B', 25),
      p('Abonnement Copies N/B', 10),
      p('Plastification A4', 150),
    ]);
    expect(g.map((x) => x.group)).toEqual(['Copies & impression', 'Plastification', 'Reliure']);
    expect(g[0]!.products.map((x) => x.name)).toEqual([
      'Abonnement Copies N/B',
      'Photocopies A4 N&B',
    ]);
  });
});
