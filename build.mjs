// Builds the extension into extension/dist/: `chromium/` (load unpacked) and `aeonproxy-extension-<version>.zip` (Chrome
// Web Store, Edge Add-ons, Opera). `--dev <origin>` builds a test copy that talks to a local site instead
// (extension/test/e2e.mjs): SITE and the check URLs point there and the content script also runs on that origin.
// `--public` also puts the zip and `extension.json` (latest version, size, SHA-256) into the site's public/downloads/,
// which the download page /browser-extension and the extension's own update notice read; `npm run build` runs it first
// (package.json "prebuild"), so every release of the site serves the extension of the same commit.
// Usage: node extension/build.mjs [--public] [--dev http://127.0.0.1:3110 --check http://check.test/ip]
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const dev = arg('--dev'), check = arg('--check');
const out = join(root, 'dist', dev ? 'dev' : 'chromium');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'src'), out, { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, 'src/manifest.json'), 'utf8'));
if (dev) {
  const o = new URL(dev).origin;
  manifest.name = `${manifest.name} (dev)`;
  manifest.content_scripts[0].matches.push(`${o}/dashboard/extension*`);
  const cfg = join(out, 'lib/config.js');
  let s = readFileSync(cfg, 'utf8');
  s = s.replace("export const SITE = 'https://aeonproxy.com';", `export const SITE = '${o}';`);
  if (check) {
    s = s.replace("export const CHECK = 'https://check.aeonproxy.com/ip';", `export const CHECK = '${check}';`);
    s = s.replace("export const CHECK_PLAIN = 'http://check.aeonproxy.com/ip';", `export const CHECK_PLAIN = '${check.replace(/^https:/, 'http:')}';`);
  }
  writeFileSync(cfg, s);
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
if (!dev) {
  const zip = join(root, 'dist', `aeonproxy-extension-${manifest.version}.zip`);
  if (existsSync(zip)) rmSync(zip);
  const bytes = zipDir(out);
  writeFileSync(zip, bytes);
  console.log('built', out, 'and', zip);
  if (process.argv.includes('--public')) {
    const pub = join(root, '..', 'public', 'downloads'), file = `aeonproxy-extension-${manifest.version}.zip`;
    mkdirSync(pub, { recursive: true });
    for (const n of readdirSync(pub)) if (/^aeonproxy-extension-.*\.zip$/.test(n)) rmSync(join(pub, n));
    writeFileSync(join(pub, file), bytes);
    writeFileSync(join(pub, 'extension.json'), JSON.stringify({ version: manifest.version, url: `/downloads/${file}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2) + '\n');
    console.log('published', join(pub, file));
  }
} else console.log('built', out, 'for', dev);

/* a plain ZIP (deflate, no extra fields, fixed 1980 dates so the same sources give the same bytes) */
function zipDir(dir) {
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d).sort()) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else files.push(f); } };
  walk(dir);
  const local = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(relative(dir, f).split('\\').join('/')), data = readFileSync(f), comp = deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    local.push(h, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
