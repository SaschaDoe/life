// Netlify build step: writes public/_redirects so /api/* is proxied to your PC.
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve(import.meta.dirname, '..', 'public', '_redirects');
const url = (process.env.MYLIFE_API_URL || '').trim().replace(/\/+$/, '');

if (!url) {
  console.warn('\n⚠️  MYLIFE_API_URL ist nicht gesetzt – die App wird deployed, findet deinen PC aber nicht.');
  console.warn('   Netlify → Site configuration → Environment variables → MYLIFE_API_URL = https://dein-pc.tailXXXX.ts.net\n');
  if (fs.existsSync(out)) fs.unlinkSync(out);
  process.exit(0);
}
if (!/^https:\/\//.test(url)) {
  console.error(`❌ MYLIFE_API_URL muss mit https:// beginnen (ist: ${url})`);
  process.exit(1);
}
fs.writeFileSync(out, `/api/*  ${url}/api/:splat  200!\n`);
console.log(`✓ /api/* → ${url}/api/*`);
