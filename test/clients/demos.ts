/**
 * TypeScript (Node 20+ native fetch) demos client。
 *
 * 讀 test/clients/demos/*.txt,把每個 syntax 渲染成 SVG + PNG。
 *
 * 用法: BASE_URL=http://localhost:3000 npx tsx test/clients/demos.ts
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const SYNTAX_DIR = process.env.SYNTAX_DIR ?? resolve(__dirname, 'demos');
const OUT_DIR = process.env.OUT_DIR ?? resolve(__dirname, 'output/complex-ts');
mkdirSync(OUT_DIR, { recursive: true });

async function postRender(syntax: string, format: 'svg' | 'png'): Promise<Buffer> {
  const res = await fetch(`${BASE_URL}/render?format=${format}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ syntax }),
  });
  if (!res.ok) throw new Error(`${format} render -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main(): Promise<void> {
  const syntaxFiles = readdirSync(SYNTAX_DIR)
    .filter((f) => f.endsWith('.txt'))
    .sort();
  if (syntaxFiles.length === 0) {
    throw new Error(`no .txt files in ${SYNTAX_DIR}`);
  }

  console.log(
    `[ts] rendering ${syntaxFiles.length} templates × {svg,png}  -> ${OUT_DIR}`
  );
  for (const f of syntaxFiles) {
    const name = f.replace(/\.txt$/, '');
    const syntax = readFileSync(join(SYNTAX_DIR, f), 'utf-8');
    for (const fmt of ['svg', 'png'] as const) {
      const data = await postRender(syntax, fmt);
      writeFileSync(join(OUT_DIR, `${name}.${fmt}`), data);
      console.log(`  ${name}.${fmt}  200  ${data.length}B`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
