// Bundled typefaces (inlined by the single-file build): Inter (variable, 100–900) for UI text,
// Barlow Condensed for display type (wordmark, titles, section headers, numerals, map labels).
import inter from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2';
import cond600 from '@fontsource/barlow-condensed/files/barlow-condensed-latin-600-normal.woff2';
import cond700 from '@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2';

const FACES: [string, string, string][] = [
  ['Inter', '100 900', inter],
  ['Barlow Condensed', '600', cond600],
  ['Barlow Condensed', '700', cond700],
];

let ready: Promise<void> | null = null;

/** Register the font faces once; resolves when they are loaded (or failed). */
export function loadFonts(): Promise<void> {
  if (ready) return ready;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return (ready = Promise.resolve());
  const loads = FACES.map(([family, weight, url]) => {
    const f = new FontFace(family, `url(${url}) format('woff2')`, { weight, style: 'normal', display: 'swap' });
    document.fonts.add(f);
    return f.load().catch(() => undefined);
  });
  ready = Promise.all(loads).then(() => undefined);
  return ready;
}
