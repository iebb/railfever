// Post-build: inline the JS/CSS bundle into a single standalone HTML file
// (dist/railfever.html) that works when opened directly from disk, fully offline.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
let html = readFileSync(join(dist, 'index.html'), 'utf8');
const assets = readdirSync(join(dist, 'assets'));
for (const f of assets) {
  const content = readFileSync(join(dist, 'assets', f), 'utf8');
  if (f.endsWith('.js')) {
    const re = new RegExp(`<script[^>]*src="\\./assets/${f.replace(/\./g, '\\.')}"[^>]*></script>`);
    html = html.replace(re, () => `<script type="module">${content.replace(/<\/script/g, '<\\/script')}</script>`);
  } else if (f.endsWith('.css')) {
    const re = new RegExp(`<link[^>]*href="\\./assets/${f.replace(/\./g, '\\.')}"[^>]*>`);
    html = html.replace(re, () => `<style>${content}</style>`);
  }
}
writeFileSync(join(dist, 'railfever.html'), html);
console.log('Wrote dist/railfever.html (' + (html.length / 1024).toFixed(0) + ' KB)');
