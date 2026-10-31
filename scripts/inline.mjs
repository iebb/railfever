// Post-build: inline the JS/CSS bundle into a single standalone HTML file
// (dist/railfever.html) that works when opened directly from disk, fully offline.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
let html = readFileSync(join(dist, 'index.html'), 'utf8');
const assets = readdirSync(join(dist, 'assets'));
let scripts = 0;
for (const f of assets) {
  if (!f.endsWith('.js') && !f.endsWith('.css')) continue;
  const content = readFileSync(join(dist, 'assets', f), 'utf8');
  if (f.endsWith('.js')) {
    const re = new RegExp(`<script[^>]*src="\\./assets/${f.replace(/\./g, '\\.')}"[^>]*></script>`);
    if (re.test(html)) scripts++;
    html = html.replace(re, () => `<script type="module">${content.replace(/<\/script/gi, (match) => '<\\/' + match.slice(2))}</script>`);
  } else if (f.endsWith('.css')) {
    const re = new RegExp(`<link[^>]*href="\\./assets/${f.replace(/\./g, '\\.')}"[^>]*>`);
    html = html.replace(re, () => `<style>${content}</style>`);
  }
}
// A changed Vite layout or a missing asset must fail the build, never publish a broken offline file.
if (!scripts || /<script\b[^>]*\bsrc\s*=/i.test(html) || /<link\b[^>]*\b(?:href=["'](?:\.\/)?assets\/|rel=["'](?:stylesheet|modulepreload)["'])/i.test(html)) {
  throw new Error('Offline build has unresolved script/style assets');
}
writeFileSync(join(dist, 'railfever.html'), html);
console.log('Wrote dist/railfever.html (' + (html.length / 1024).toFixed(0) + ' KB)');
