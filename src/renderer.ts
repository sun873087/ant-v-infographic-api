import { trace, SpanStatusCode } from '@opentelemetry/api';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import {
  registerResourceLoader,
  loadSVGResource,
} from '@antv/infographic';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';

const tracer = trace.getTracer('infographic-api.renderer');

// Returned in place of `null` so upstream never falls back to its public-CDN search loader.
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em">' +
  '<rect x="1" y="1" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"/>' +
  '<text x="12" y="17" font-size="14" text-anchor="middle" fill="currentColor">?</text>' +
  '</svg>';

// SSR runs in a server (no DOM lib in tsconfig), so SVGSymbolElement is `unknown` here.
// At runtime the upstream loader returns whatever loadSVGResource produces.
type Resource = unknown;
interface ResourceConfig {
  source: string;
  data: string;
  scene?: 'icon' | 'illus' | string;
  format?: string;
  [key: string]: unknown;
}
type ResourceLoader = (config: ResourceConfig) => Promise<Resource | null>;

type RenderToString = (syntax: string) => Promise<string>;
let renderToStringFn: RenderToString | null = null;

async function loadSsrRender(): Promise<RenderToString> {
  if (renderToStringFn) return renderToStringFn;
  const mod = (await import('@antv/infographic/ssr')) as { renderToString?: RenderToString };
  if (typeof mod.renderToString !== 'function') {
    throw new Error(
      '@antv/infographic/ssr does not export renderToString (got: ' +
        Object.keys(mod).join(', ') +
        ')'
    );
  }
  renderToStringFn = mod.renderToString;
  return renderToStringFn;
}

export class RenderError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly kind: 'timeout' | 'syntax' | 'internal' = 'internal'
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

export class Renderer {
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly iconCache = new Map<string, string>();
  private browser: Browser | null = null;

  constructor(
    private readonly config: Config,
    private readonly logger: FastifyBaseLogger
  ) {}

  async warmUp(): Promise<void> {
    try {
      await loadSsrRender();
      registerResourceLoader(this.buildResourceLoader() as Parameters<typeof registerResourceLoader>[0]);
      this.logger.info(
        {
          iconifyHost: this.config.ICONIFY_API_HOST,
          illusHost: this.config.ILLUSTRATION_HOST || '(disabled)',
        },
        'Registered custom resource loader'
      );
      // Establish the browser eagerly so /readyz can fail fast if the endpoint
      // is wrong. Subsequent PNG renders go through getBrowser() which auto-reconnects.
      await this.getBrowser();
      this.logger.info('Renderer warmed up');
    } catch (err) {
      this.logger.error({ err }, 'Renderer warm-up failed');
      throw err;
    }
  }

  /**
   * Returns a connected Browser. Reconnects automatically if the previous handle
   * was dropped (e.g. browserless idle timeout killed the session).
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;

    if (this.config.BROWSER_WS_ENDPOINT) {
      const browser = await chromium.connect(this.config.BROWSER_WS_ENDPOINT);
      browser.on('disconnected', () => {
        this.logger.warn('Remote Chromium disconnected; will reconnect on next render');
        if (this.browser === browser) this.browser = null;
      });
      this.logger.info(
        { endpoint: this.config.BROWSER_WS_ENDPOINT.replace(/token=[^&]+/, 'token=***') },
        'Connected to remote Chromium'
      );
      this.browser = browser;
    } else {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      this.logger.info('Local Chromium launched (no BROWSER_WS_ENDPOINT)');
    }
    return this.browser;
  }

  async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  private buildResourceLoader(): ResourceLoader {
    return async (config) => {
      const scene = config.scene ?? 'icon';
      const data = config.data;

      // Never return null: upstream falls back to its search loader (weavefox.cn)
      // if we do. Always emit a placeholder symbol so security review stays happy.
      if (
        !data ||
        (scene !== 'icon' && scene !== 'illus') ||
        (scene === 'illus' && !this.config.ILLUSTRATION_HOST)
      ) {
        this.logger.warn({ scene, data }, 'Resource request not satisfiable, using placeholder');
        return loadSVGResource(PLACEHOLDER_SVG) as Resource;
      }

      const svgText = await this.getResourceText(scene as 'icon' | 'illus', data);
      // loadSVGResource needs the SSR DOM shim — safe to call here because the
      // custom loader is invoked during renderToString, when the shim is active.
      return loadSVGResource(svgText ?? PLACEHOLDER_SVG) as Resource;
    };
  }

  private async getResourceText(
    scene: 'icon' | 'illus',
    data: string
  ): Promise<string | null> {
    const cacheKey = `${scene}::${data}`;
    const cached = this.iconCache.get(cacheKey);
    if (cached) return cached;

    const pending = this.inflight.get(cacheKey);
    if (pending) return pending;

    const promise = this.fetchResource(scene, data)
      .then((svg) => {
        if (svg) this.iconCache.set(cacheKey, svg);
        return svg;
      })
      .finally(() => {
        this.inflight.delete(cacheKey);
      });
    this.inflight.set(cacheKey, promise);
    return promise;
  }

  private async fetchResource(
    scene: 'icon' | 'illus',
    data: string
  ): Promise<string | null> {
    return tracer.startActiveSpan(`resource.fetch.${scene}`, async (span) => {
      span.setAttribute('resource.scene', scene);
      span.setAttribute('resource.data', data);

      const host =
        scene === 'icon'
          ? this.config.ICONIFY_API_HOST
          : this.config.ILLUSTRATION_HOST;
      const url = `${host.replace(/\/$/, '')}/${data}.svg`;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          this.config.RESOURCE_FETCH_TIMEOUT_MS
        );

        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!res.ok) {
          this.logger.warn({ url, status: res.status }, 'Resource fetch failed');
          span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.status}` });
          return null;
        }

        const text = await res.text();
        span.setAttribute('resource.bytes', text.length);
        return text;
      } catch (err) {
        this.logger.warn({ err, url }, 'Resource fetch error');
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        return null;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Rasterize an SVG to PNG via headless Chromium (Playwright).
   *
   * AntV Infographic 用 <foreignObject> 包 HTML span 排版文字,resvg 完全不支援。
   * Chromium 原生支援 foreignObject + Web Font + flexbox,因此 fidelity 最高。
   *
   * 成本:每張 PNG 約 200-800ms(開 page → setContent → fonts ready → screenshot)。
   */
  async renderPng(svg: string): Promise<Buffer> {
    return tracer.startActiveSpan('renderer.renderPng', async (span) => {
      const browser = await this.getBrowser();
      const page = await browser.newPage();
      try {
        // Apply the same outbound allow-list to Chromium's network as the Node-side
        // fetch firewall — keeps "no public CDN leak" guarantee intact.
        const allowedHosts = (process.env.ALLOWED_FETCH_HOSTS ?? '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        if (allowedHosts.length > 0) {
          await page.route('**/*', (route) => {
            try {
              const host = new URL(route.request().url()).hostname.toLowerCase();
              if (allowedHosts.includes(host)) return route.continue();
            } catch { /* fall through to abort */ }
            return route.abort();
          });
        }

        await page.setContent(
          `<!doctype html><html><body style="margin:0;padding:0">${svg}</body></html>`,
          { waitUntil: 'networkidle' }
        );
        // Make sure Web Fonts (Alibaba PuHuiTi etc.) have loaded before snapshot.
        // Passing as a string sidesteps TS strictness about `document.fonts` types,
        // which aren't in our `lib: ["ES2022"]` config.
        await page.evaluate('document.fonts && document.fonts.ready');

        const handle = await page.locator('svg').first();
        const png = await handle.screenshot({ omitBackground: true });
        span.setAttribute('png.bytes', png.length);
        return Buffer.from(png);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw new RenderError(
          `PNG conversion failed: ${(err as Error)?.message ?? String(err)}`,
          err,
          'internal'
        );
      } finally {
        await page.close().catch(() => {});
        span.end();
      }
    });
  }

  async render(syntax: string): Promise<string> {
    return tracer.startActiveSpan('renderer.render', async (span) => {
      span.setAttribute('syntax.bytes', Buffer.byteLength(syntax, 'utf-8'));

      try {
        const renderToString = await loadSsrRender();
        const timeoutMs = this.config.RENDER_TIMEOUT_MS;
        const svg = await Promise.race([
          renderToString(syntax),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new RenderError(
                    `Render timed out after ${timeoutMs}ms`,
                    undefined,
                    'timeout'
                  )
                ),
              timeoutMs
            )
          ),
        ]);

        if (typeof svg !== 'string' || !svg.includes('<svg')) {
          throw new RenderError('Renderer returned non-SVG output', undefined, 'internal');
        }

        span.setAttribute('svg.bytes', Buffer.byteLength(svg, 'utf-8'));
        return svg;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (err instanceof RenderError) throw err;
        const msg = (err as Error)?.message ?? String(err);
        if (/syntax|parse|template/i.test(msg)) {
          throw new RenderError(msg, err, 'syntax');
        }
        throw new RenderError(msg, err, 'internal');
      } finally {
        span.end();
      }
    });
  }
}
