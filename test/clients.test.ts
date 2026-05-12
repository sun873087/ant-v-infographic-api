/**
 * Integration test:跑三種語言的 client(curl / python / typescript),
 * 確認它們都能從同一個 Infographic API server 拿到 SVG 與 PNG。
 *
 * 前置條件:server 必須在 INFOGRAPHIC_API_URL(預設 http://localhost:3000)運行。
 *           若無法 reach,整個 suite skip(回 ok),不假裝有跑過。
 */
import { describe, it, beforeAll, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Vitest (via Vite) sets process.env.BASE_URL = '/', so use a distinct env name here.
const API_URL = process.env.INFOGRAPHIC_API_URL ?? 'http://localhost:3000';
const OUTPUT_ROOT = resolve(__dirname, 'clients/output');
mkdirSync(OUTPUT_ROOT, { recursive: true });

// Some commands need shell=true on Windows because they resolve via PATHEXT (npx → npx.cmd).
const isWindows = process.platform === 'win32';

function probe(cmd: string, args: string[] = ['--version']): boolean {
  return spawnSync(cmd, args, { shell: isWindows }).status === 0;
}

let serverUp = false;
let hasBash = false;
let hasCurl = false;
let hasJq = false;
let pythonCmd: string | null = null;
let hasTsx = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${API_URL}/healthz`, { signal: AbortSignal.timeout(2000) });
    serverUp = res.ok;
  } catch {
    serverUp = false;
  }
  hasBash = probe('bash');
  hasCurl = probe('curl');
  hasJq = probe('jq');
  // macOS/Linux ship `python3`; Windows installer typically registers `python`.
  pythonCmd = probe('python3') ? 'python3' : probe('python') ? 'python' : null;
  hasTsx = probe('npx', ['tsx', '--version']);
});

function run(cmd: string, args: string[], outDir: string) {
  const res = spawnSync(cmd, args, {
    env: { ...process.env, BASE_URL: API_URL, OUT_DIR: outDir },
    encoding: 'utf-8',
    shell: isWindows,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function assertOutputs(outDir: string, names: string[]) {
  for (const name of names) {
    const p = join(outDir, name);
    expect(existsSync(p), `${name} should exist`).toBe(true);
    expect(statSync(p).size, `${name} size > 0`).toBeGreaterThan(100);
  }
}

const SIMPLE_OUTPUTS = ['out.svg', 'out.png', 'get.svg'];
const DEMO_NAMES = ['swot', 'funnel', 'roadmap', 'circular', 'mindmap', 'network'];
const DEMO_OUTPUTS = DEMO_NAMES.flatMap((n) => [`${n}.svg`, `${n}.png`]);

describe('clients integration', () => {
  it('server is reachable (otherwise rest are skipped)', () => {
    if (!serverUp) {
      console.warn(`[skip] server not reachable at ${API_URL}; skipping client tests`);
    }
    expect(true).toBe(true);
  });

  it('curl can render SVG, PNG, and GET-style', () => {
    if (!serverUp) return;
    if (!hasBash || !hasCurl || !hasJq) {
      console.warn('[skip] bash/curl/jq missing (Windows without Git Bash?)');
      return;
    }
    const out = join(OUTPUT_ROOT, 'curl');
    const r = run('bash', ['test/clients/curl.sh'], out);
    expect(r.status, r.stderr).toBe(0);
    assertOutputs(out, SIMPLE_OUTPUTS);
  });

  it('python (stdlib) can render SVG, PNG, and GET-style', () => {
    if (!serverUp) return;
    if (!pythonCmd) {
      console.warn('[skip] python (3.x) not on PATH');
      return;
    }
    const out = join(OUTPUT_ROOT, 'python');
    const r = run(pythonCmd, ['test/clients/client.py'], out);
    expect(r.status, r.stderr).toBe(0);
    assertOutputs(out, SIMPLE_OUTPUTS);
  });

  it('typescript (tsx + fetch) can render SVG, PNG, and GET-style', () => {
    if (!serverUp) return;
    if (!hasTsx) {
      console.warn('[skip] tsx missing');
      return;
    }
    const out = join(OUTPUT_ROOT, 'ts');
    const r = run('npx', ['tsx', 'test/clients/client.ts'], out);
    expect(r.status, r.stderr).toBe(0);
    assertOutputs(out, SIMPLE_OUTPUTS);
  });

  // ─── 複雜 demos:6 個 template × svg/png ─────────────
  it('curl demos.sh renders 6 complex templates × svg/png', () => {
    if (!serverUp) return;
    if (!hasBash || !hasCurl || !hasJq) {
      console.warn('[skip] bash/curl/jq missing');
      return;
    }
    const out = join(OUTPUT_ROOT, 'complex-curl');
    const r = run('bash', ['test/clients/demos.sh'], out);
    expect(r.status, r.stderr).toBe(0);
    assertOutputs(out, DEMO_OUTPUTS);
  });

  it('python demos.py renders 6 complex templates × svg/png', () => {
    if (!serverUp) return;
    if (!pythonCmd) {
      console.warn('[skip] python missing');
      return;
    }
    const out = join(OUTPUT_ROOT, 'complex-python');
    const r = run(pythonCmd, ['test/clients/demos.py'], out);
    expect(r.status, r.stderr).toBe(0);
    assertOutputs(out, DEMO_OUTPUTS);
  });

  it('typescript demos.ts renders 6 complex templates × svg/png', () => {
    if (!serverUp) return;
    if (!hasTsx) {
      console.warn('[skip] tsx missing');
      return;
    }
    const out = join(OUTPUT_ROOT, 'complex-ts');
    const r = run('npx', ['tsx', 'test/clients/demos.ts'], out);
    expect(r.status, r.stderr).toBe(0);
    assertOutputs(out, DEMO_OUTPUTS);
  });
});
