export function normalizeOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    const protocol = url.protocol;
    const hostname = url.hostname;
    const port = url.port;
    const isHttps = protocol === 'https:';
    const defaultPort = isHttps ? '443' : '80';
    if (port && port !== '' && port !== defaultPort) {
      return `${protocol}//${hostname}:${port}`;
    }
    return `${protocol}//${hostname}`;
  } catch {
    return null;
  }
}

export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return false;
  return allowedOrigins.some(allowed => {
    const normalizedAllowed = normalizeOrigin(allowed);
    if (!normalizedAllowed) return false;
    return normalizedOrigin === normalizedAllowed;
  });
}

export function parseSeoOrigins(): string[] {
  if (!process.env.SEO_ALLOWED_ORIGINS) return [];
  return process.env.SEO_ALLOWED_ORIGINS.split(',').map(url => url.trim()).filter(Boolean);
}
