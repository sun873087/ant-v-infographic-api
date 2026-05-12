import { z } from 'zod';

const ConfigSchema = z.object({
  // Server
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Redis cache
  REDIS_URL: z.string().default('redis://localhost:6379'),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86400), // 1 day
  CACHE_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),

  // Rendering
  RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  MAX_SYNTAX_BYTES: z.coerce.number().int().positive().default(64 * 1024), // 64 KiB

  // Resource hosts (internal mirrors)
  // ICONIFY_API_HOST: host of your self-hosted Iconify server.
  // Path shape MUST match api.iconify.design: /<collection>/<name>.svg
  ICONIFY_API_HOST: z.string().url().default('https://iconify.your-company.internal'),
  // ILLUSTRATION_HOST: optional; leave empty to disable undraw illustrations
  ILLUSTRATION_HOST: z.string().default(''),
  RESOURCE_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),

  // Remote Chromium via WebSocket (browserless / browserless-style endpoint).
  // Format: ws://browserless:3000/chromium/playwright?token=YOUR_TOKEN
  // Leave empty to launch a local Chromium (requires playwright system deps installed).
  BROWSER_WS_ENDPOINT: z.string().default(''),

  // OpenTelemetry
  OTEL_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318'),
  OTEL_SERVICE_NAME: z.string().default('infographic-api'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment configuration:', result.error.format());
    process.exit(1);
  }
  return result.data;
}
