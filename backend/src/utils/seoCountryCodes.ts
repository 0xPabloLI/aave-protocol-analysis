export const GSC_TO_SEMRUSH: Readonly<Record<string, string>> = {
  bra: 'br',
  fra: 'fr',
  tur: 'tr',
  usa: 'us',
  deu: 'de',
  ind: 'in',
};

export const SEMRUSH_TO_GSC: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(GSC_TO_SEMRUSH).map(([g, s]) => [s, g]),
) as Record<string, string>;
