/**
 * OpenTelemetry initialization.
 *
 * IMPORTANT: This file must be imported at the very top of server.ts,
 * BEFORE any other module, so that auto-instrumentation can patch them.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

const OTEL_ENABLED = process.env.OTEL_ENABLED !== 'false';
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'infographic-api';
const OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

let sdk: NodeSDK | null = null;

if (OTEL_ENABLED) {
  sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${OTLP_ENDPOINT}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // 關閉一些噪音大的 instrumentations
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });

  sdk.start();

  // 優雅關閉
  process.on('SIGTERM', () => {
    sdk
      ?.shutdown()
      .catch((err) => console.error('Error shutting down OTel SDK', err))
      .finally(() => process.exit(0));
  });
}

export { sdk };
