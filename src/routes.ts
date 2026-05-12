import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { SvgCache } from './cache.js';
import { Renderer, RenderError } from './renderer.js';
import type { Config } from './config.js';

const RenderBodySchema = z.object({
  syntax: z.string().min(1),
});

const FormatSchema = z.enum(['svg', 'png']).default('svg');
type Format = z.infer<typeof FormatSchema>;

interface RouteDeps {
  cache: SvgCache;
  renderer: Renderer;
  config: Config;
}

const exampleSyntax =
  'infographic list-row-horizontal-icon-arrow\n' +
  'data\n' +
  '  items\n' +
  '    - label Plan\n' +
  '      desc Design\n' +
  '      icon mdi/lightbulb-outline\n' +
  '    - label Build\n' +
  '      desc Hammer time\n' +
  '      icon mdi/hammer-screwdriver\n' +
  '    - label Ship\n' +
  '      desc Go live\n' +
  '      icon mdi/rocket-launch';

const errorBodySchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    detail: {},
  },
  required: ['error'],
};

export async function registerRoutes(
  app: FastifyInstance,
  deps: RouteDeps
): Promise<void> {
  const { cache, renderer, config } = deps;

  app.get(
    '/healthz',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        description: '服務有在跑就回 200,不做任何依賴檢查。',
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['ok'] } },
          },
        },
      },
    },
    async () => ({ status: 'ok' })
  );

  app.get(
    '/readyz',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness probe',
        description: '會跑一次真實渲染確認 renderer warm-up 完成。',
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['ready'] } },
          },
          503: errorBodySchema,
        },
      },
    },
    async (_req, reply) => {
      try {
        await renderer.render(
          'infographic list-row-simple-horizontal-arrow\ndata\n  items\n    - label probe'
        );
        return { status: 'ready' };
      } catch (err) {
        return reply.code(503).send({ status: 'not_ready', detail: String(err) });
      }
    }
  );

  app.post<{ Querystring: { format?: string }; Body: { syntax: string } }>(
    '/render',
    {
      schema: {
        tags: ['render'],
        summary: 'Render infographic (POST,主力 API)',
        description:
          '把 AntV Infographic syntax 轉成 SVG 或 PNG。\n\n' +
          'PNG 由 SVG 經 resvg 轉換,因 `<foreignObject>` 限制,文字可能缺失。',
        querystring: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['svg', 'png'], default: 'svg' },
          },
        },
        body: {
          type: 'object',
          required: ['syntax'],
          properties: {
            syntax: {
              type: 'string',
              description: 'AntV Infographic syntax(YAML-like)',
              examples: [exampleSyntax],
            },
          },
        },
        response: {
          200: {
            description: 'SVG 或 PNG bytes。回傳 Content-Type 視 format 而定。',
            content: {
              'image/svg+xml': { schema: { type: 'string' } },
              'image/png': { schema: { type: 'string', format: 'binary' } },
            },
          },
          400: errorBodySchema,
          413: errorBodySchema,
          500: errorBodySchema,
          504: errorBodySchema,
        },
      },
    },
    async (req, reply) => {
      const parsed = RenderBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.format() });
      }
      const formatParsed = FormatSchema.safeParse(req.query.format ?? 'svg');
      if (!formatParsed.success) {
        return reply.code(400).send({ error: 'invalid_format', detail: 'format must be svg or png' });
      }
      const { syntax } = parsed.data;
      const byteLen = Buffer.byteLength(syntax, 'utf-8');
      if (byteLen > config.MAX_SYNTAX_BYTES) {
        return reply.code(413).send({
          error: 'payload_too_large',
          detail: `Syntax is ${byteLen} bytes, limit is ${config.MAX_SYNTAX_BYTES}`,
        });
      }
      return serveImage(syntax, formatParsed.data, reply, cache, renderer);
    }
  );

  for (const format of ['svg', 'png'] as const) {
    app.get<{ Params: { encoded: string } }>(
      `/render/:encoded.${format}`,
      {
        schema: {
          tags: ['render'],
          summary: `Render infographic (GET, ${format.toUpperCase()})`,
          description:
            `Kroki-style URL:把 syntax 用 base64url 編碼塞進 path,適合 \`<img src>\`。\n\n` +
            'syntax 較大(>~6KB base64url)請改走 POST。',
          params: {
            type: 'object',
            properties: {
              encoded: {
                type: 'string',
                description: 'base64url(syntax)',
                examples: [
                  Buffer.from(
                    'infographic list-row-simple-horizontal-arrow\ndata\n  items\n    - label A'
                  ).toString('base64url'),
                ],
              },
            },
            required: ['encoded'],
          },
          response: {
            200: {
              description: `${format.toUpperCase()} bytes`,
              content: {
                [format === 'svg' ? 'image/svg+xml' : 'image/png']: {
                  schema: { type: 'string', format: format === 'png' ? 'binary' : undefined },
                },
              },
            },
            400: errorBodySchema,
            413: errorBodySchema,
            500: errorBodySchema,
            504: errorBodySchema,
          },
        },
      },
      async (req, reply) => {
        const { encoded } = req.params;
        let syntax: string;
        try {
          syntax = Buffer.from(encoded, 'base64url').toString('utf-8');
        } catch {
          return reply.code(400).send({ error: 'invalid_base64url' });
        }
        const byteLen = Buffer.byteLength(syntax, 'utf-8');
        if (byteLen > config.MAX_SYNTAX_BYTES) {
          return reply.code(413).send({
            error: 'payload_too_large',
            detail: `Syntax is ${byteLen} bytes, limit is ${config.MAX_SYNTAX_BYTES}`,
          });
        }
        return serveImage(syntax, format, reply, cache, renderer);
      }
    );
  }

  app.get(
    '/templates',
    {
      schema: {
        tags: ['meta'],
        summary: 'Template list(stub)',
        description: 'AntV Infographic 尚未提供官方 template 列舉 API,目前為 stub。',
        response: {
          200: {
            type: 'object',
            properties: { note: { type: 'string' }, docsUrl: { type: 'string' } },
          },
        },
      },
    },
    async () => ({
      note: 'Template enumeration not yet implemented. See AntV docs.',
      docsUrl: 'https://infographic.antv.vision/',
    })
  );
}

async function serveImage(
  syntax: string,
  format: Format,
  reply: FastifyReply,
  cache: SvgCache,
  renderer: Renderer
): Promise<void> {
  let svg = await cache.get(syntax);
  let cacheStatus: 'HIT' | 'MISS' = 'HIT';
  if (!svg) {
    cacheStatus = 'MISS';
    try {
      svg = await renderer.render(syntax);
      await cache.set(syntax, svg);
    } catch (err) {
      return sendRenderError(reply, err);
    }
  }

  reply.header('X-Cache', cacheStatus);
  if (format === 'svg') {
    reply.type('image/svg+xml; charset=utf-8');
    return reply.send(svg);
  }
  try {
    const png = await renderer.renderPng(svg);
    reply.type('image/png');
    return reply.send(png);
  } catch (err) {
    return sendRenderError(reply, err);
  }
}

function sendRenderError(reply: FastifyReply, err: unknown): void {
  if (err instanceof RenderError) {
    const code = err.kind === 'syntax' ? 400 : err.kind === 'timeout' ? 504 : 500;
    reply.code(code).send({ error: `render_${err.kind}`, detail: err.message });
    return;
  }
  reply.code(500).send({ error: 'internal_error', detail: String(err) });
}
