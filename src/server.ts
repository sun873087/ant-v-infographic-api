// Firewall MUST load before anything that may call fetch (incl. OTel exporters).
import './fetch-firewall.js';
// OTel auto-instrumentation must be next, before app modules.
import './telemetry.js';

import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { loadConfig } from './config.js';
import { SvgCache } from './cache.js';
import { Renderer } from './renderer.js';
import { registerRoutes } from './routes.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { colorize: true } },
    },
    bodyLimit: config.MAX_SYNTAX_BYTES + 1024, // small headroom for JSON wrapper
    // base64url(syntax) is ~4/3 of syntax size; cap at 8 KiB to stay within
    // common URL-length limits. Larger payloads should use POST /render.
    maxParamLength: 8192,
    disableRequestLogging: false,
    trustProxy: true,
  });

  await app.register(sensible);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Infographic API',
        description:
          'Kroki-style HTTP service for AntV Infographic. ' +
          'Takes infographic syntax, returns SVG (or PNG).',
        version: '0.1.0',
      },
      servers: [{ url: `http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}` }],
      tags: [
        { name: 'render', description: '渲染 infographic' },
        { name: 'health', description: 'K8s probes' },
        { name: 'meta', description: '模板列舉等' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
    staticCSP: true,
  });

  const cache = new SvgCache(config, app.log);
  await cache.connect();

  const renderer = new Renderer(config, app.log);
  await renderer.warmUp();

  await registerRoutes(app, { cache, renderer, config });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Received shutdown signal');
    try {
      await app.close();
      await cache.disconnect();
      await renderer.shutdown();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    app.log.info(`Infographic API listening on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

void bootstrap();
