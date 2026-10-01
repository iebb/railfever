// Bundled typefaces (inlined by the single-file build): Barlow for UI text, Barlow Condensed for display.
import barlow400 from '@fontsource/barlow/files/barlow-latin-400-normal.woff2';
import barlow500 from '@fontsource/barlow/files/barlow-latin-500-normal.woff2';
import barlow600 from '@fontsource/barlow/files/barlow-latin-600-normal.woff2';
import cond600 from '@fontsource/barlow-condensed/files/barlow-condensed-latin-600-normal.woff2';
import cond700 from '@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2';

const FACES: [string, string, string][] = [
  ['Barlow', '400', barlow400],
  ['Barlow', '500', barlow500],
  ['Barlow', '600', barlow600],
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
