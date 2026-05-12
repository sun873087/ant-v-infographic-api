/**
 * 使用 TypeScript (Node 20+ 內建 fetch) 呼叫 Infographic API。
 *
 * 用法:
 *   BASE_URL=http://localhost:3000 npx tsx test/clients/client.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { strict as assert } from 'node:assert';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const OUT_DIR = process.env.OUT_DIR ?? join(tmpdir(), 'infographic-ts');
mkdirSync(OUT_DIR, { recursive: true });

const SYNTAX = `infographic list-row-horizontal-icon-arrow
data
  items
    - label Plan
      desc Design
      icon mdi/lightbulb-outline
    - label Build
      icon mdi/hammer-screwdriver
    - label Ship
      icon mdi/rocket-launch`;

async function postRender(syntax: string, format: 'svg' | 'png' = 'svg'): Promise<Buffer> {
  const res = await fetch(`${BASE_URL}/render?format=${format}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ syntax }),
  });
  if (!res.ok) throw new Error(`POST /render -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function base64url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64url');
}

async function main(): Promise<void> {
  const health = await fetch(`${BASE_URL}/healthz`).then((r) => r.json() as Promise<{ status: string }>);
  assert.equal(health.status, 'ok');
  console.log('[ts] healthz OK');

  const svg = await postRender(SYNTAX, 'svg');
  writeFileSync(join(OUT_DIR, 'out.svg'), svg);
  assert.ok(svg.toString('utf-8').includes('<svg'));
  console.log(`[ts] POST /render?format=svg  ${svg.length}B`);

  const png = await postRender(SYNTAX, 'png');
  writeFileSync(join(OUT_DIR, 'out.png'), png);
  assert.equal(png.slice(0, 8).toString('hex'), '89504e470d0a1a0a'); // PNG magic
  console.log(`[ts] POST /render?format=png  ${png.length}B`);

  const encoded = base64url(SYNTAX);
  const res = await fetch(`${BASE_URL}/render/${encoded}.svg`);
  assert.equal(res.status, 200);
  const svg2 = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(OUT_DIR, 'get.svg'), svg2);
  console.log(`[ts] GET /render/:enc.svg     ${svg2.length}B  X-Cache=${res.headers.get('x-cache')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
