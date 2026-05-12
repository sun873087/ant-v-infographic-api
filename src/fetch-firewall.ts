/**
 * Outbound fetch firewall.
 *
 * Reads ALLOWED_FETCH_HOSTS (comma-separated hostnames) from process.env at
 * module load time and replaces globalThis.fetch with a wrapper that rejects
 * any request whose hostname is not on the allow-list.
 *
 * MUST be imported before any other module that may call fetch. Empty/missing
 * env var means no filtering (dev convenience) — production should always set it.
 *
 * Defense rationale: @antv/infographic 0.2.x silently calls public services
 * (e.g. weavefox.cn icon search) via paths that bypass registerResourceLoader.
 * The firewall is a second line of defense behind the custom resource loader.
 */
const raw = process.env.ALLOWED_FETCH_HOSTS ?? '';
const allowed = new Set(
  raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

if (allowed.size === 0) {
  // eslint-disable-next-line no-console
  console.warn(
    '[fetch-firewall] ALLOWED_FETCH_HOSTS is empty — outbound fetch is NOT restricted. ' +
      'Set this in production.'
  );
} else {
  const original = globalThis.fetch.bind(globalThis);

  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    const [input] = args;
    const urlString =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url: string }).url;

    let host: string;
    try {
      host = new URL(urlString).hostname.toLowerCase();
    } catch {
      return Promise.reject(
        new Error(`[fetch-firewall] invalid URL: ${urlString}`)
      );
    }

    if (!allowed.has(host)) {
      return Promise.reject(
        new Error(
          `[fetch-firewall] blocked: "${host}" is not in ALLOWED_FETCH_HOSTS ` +
            `(allowed: ${[...allowed].join(', ')})`
        )
      );
    }

    return original(...args);
  }) as typeof fetch;
}

export const allowedFetchHosts = [...allowed];
