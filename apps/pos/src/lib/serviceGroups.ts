import type { PosProduct } from '@/types/pos';

/** Familles de prestations (accès direct en caisse), dans l'ordre d'affichage. */
export const SERVICE_GROUPS = [
  'Copies & impression',
  'Numérisation',
  'Plastification',
  'Reliure',
  'Photos',
  'Grand format',
  'Autres services',
] as const;

export type ServiceGroup = (typeof SERVICE_GROUPS)[number];

/** Famille d'une prestation d'après son libellé (catégorie « Services » du catalogue). */
export function serviceGroupOf(name: string): ServiceGroup {
  const n = name.toLowerCase();
  if (/reliure/.test(n)) return 'Reliure';
  if (/plastif/.test(n)) return 'Plastification';
  if (/num[ée]ris/.test(n)) return 'Numérisation';
  if (/^photo(?!cop)/.test(n)) return 'Photos';
  if (/b[âa]che|affiche|^plan\b|flyers?|grand format/.test(n)) return 'Grand format';
  if (/photocop|copies?\b|impression/.test(n)) return 'Copies & impression';
  return 'Autres services';
}

export interface ServiceGroupEntry {
  group: ServiceGroup;
  products: PosProduct[];
}

/** Regroupe les prestations par famille (familles vides omises), tri par prix puis nom. */
export function groupServices(products: PosProduct[]): ServiceGroupEntry[] {
  const map = new Map<ServiceGroup, PosProduct[]>();
  for (const p of products) {
    const g = serviceGroupOf(p.name);
    const list = map.get(g);
    if (list) list.push(p);
    else map.set(g, [p]);
  }
  return SERVICE_GROUPS.filter((g) => map.has(g)).map((group) => ({
    group,
    products: [...(map.get(group) ?? [])].sort(
      (a, b) => a.price_ttc_cents - b.price_ttc_cents || a.name.localeCompare(b.name, 'fr'),
    ),
  }));
}
