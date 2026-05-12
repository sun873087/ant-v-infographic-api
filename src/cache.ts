import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { Config } from './config.js';
import type { FastifyBaseLogger } from 'fastify';

const tracer = trace.getTracer('infographic-api.cache');

export class SvgCache {
  private client: Redis | null = null;
  private readonly ttl: number;
  private readonly enabled: boolean;

  constructor(
    private readonly config: Config,
    private readonly logger: FastifyBaseLogger
  ) {
    this.ttl = config.CACHE_TTL_SECONDS;
    this.enabled = config.CACHE_ENABLED;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      this.logger.info('Cache disabled by config');
      return;
    }

    this.client = new Redis(this.config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });

    this.client.on('error', (err) => {
      this.logger.error({ err }, 'Redis error');
    });

    try {
      await this.client.connect();
      this.logger.info('Connected to Redis');
    } catch (err) {
      this.logger.error({ err }, 'Failed to connect to Redis, continuing without cache');
      this.client = null;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }

  /**
   * Generate a deterministic cache key from syntax string.
   * Same syntax → same key, regardless of whitespace at the edges.
   */
  static keyFor(syntax: string): string {
    const normalized = syntax.trim();
    const hash = createHash('sha256').update(normalized).digest('hex');
    return `infographic:svg:${hash}`;
  }

  async get(syntax: string): Promise<string | null> {
    if (!this.client) return null;

    return tracer.startActiveSpan('cache.get', async (span) => {
      try {
        const key = SvgCache.keyFor(syntax);
        const value = await this.client!.get(key);
        span.setAttribute('cache.key', key);
        span.setAttribute('cache.hit', value !== null);
        return value;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        this.logger.warn({ err }, 'Cache get failed');
        return null;
      } finally {
        span.end();
      }
    });
  }

  async set(syntax: string, svg: string): Promise<void> {
    if (!this.client) return;

    return tracer.startActiveSpan('cache.set', async (span) => {
      try {
        const key = SvgCache.keyFor(syntax);
        await this.client!.setex(key, this.ttl, svg);
        span.setAttribute('cache.key', key);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        this.logger.warn({ err }, 'Cache set failed');
      } finally {
        span.end();
      }
    });
  }
}
