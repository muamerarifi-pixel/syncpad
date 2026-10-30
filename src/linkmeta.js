// Link-preview helpers (carried over from v1, SSRF-safe fetch + HTML metadata parsing)
export function isPrivateOrLocalHost(hostname) {
  if (!hostname) return true;
  const raw = hostname.toLowerCase().trim();
  const host = raw.replace(/^\[|\]$/g, '');

  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::' ||
    host === '0:0:0:0:0:0:0:1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    host === 'instance-data'
  ) {
    return true;
  }

  // IPv6 mapped IPv4 or special ranges
  if (host.startsWith('::ffff:')) {
    return isPrivateOrLocalHost(host.substring(7));
  }
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }

  // IPv4 check: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (link-local), 100.64.0.0/10
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = parseInt(ipv4Match[1], 10);
    const b = parseInt(ipv4Match[2], 10);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // cloud metadata / link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }

  return false;
}

/**
 * Decode HTML entities in extracted metadata
 */
export function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch (_) { return _; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch (_) { return _; }
    })
    .trim();
}

/**
 * Safe fetch following HTTP redirects with per-hop SSRF validation
 */
export async function safeFetchWithRedirects(targetUrl, options = {}, maxRedirects = 4) {
  let currentUrl = targetUrl;
  let redirects = 0;

  while (redirects <= maxRedirects) {
    const parsed = new URL(currentUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || isPrivateOrLocalHost(parsed.hostname)) {
      throw new Error('Access to private or restricted network address is forbidden');
    }

    const fetchOpts = {
      ...options,
      redirect: 'manual'
    };

    const res = await fetch(currentUrl, fetchOpts);

    if (res.status >= 301 && res.status <= 308) {
      const location = res.headers.get('location');
      if (!location) return res;

      const nextUrl = new URL(location, currentUrl).href;
      currentUrl = nextUrl;
      redirects++;
      continue;
    }

    return res;
  }

  throw new Error('Too many redirects');
}

/**
 * Extract OpenGraph and HTML metadata from HTML text
 */
export function extractHtmlMetadata(html, targetUrl) {
  const result = {
    title: '',
    description: '',
    image: '',
    siteName: '',
    favicon: ''
  };

  try {
    const baseUrl = new URL(targetUrl);
    result.siteName = baseUrl.hostname.replace(/^www\./i, '');
    result.favicon = `${baseUrl.origin}/favicon.ico`;

    // Parse all <meta> tags into key-value attribute maps
    const metaRegex = /<meta\s+([^>]+)>/gi;
    let metaMatch;
    const metas = [];
    while ((metaMatch = metaRegex.exec(html)) !== null) {
      const attrStr = metaMatch[1];
      const attrs = {};
      const attrRegex = /([a-zA-Z0-9_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
      let aMatch;
      while ((aMatch = attrRegex.exec(attrStr)) !== null) {
        const k = aMatch[1].toLowerCase();
        const v = aMatch[2] !== undefined ? aMatch[2] : (aMatch[3] !== undefined ? aMatch[3] : aMatch[4]);
        attrs[k] = v;
      }
      metas.push(attrs);
    }

    // Helper to find meta tag by property or name
    const findMeta = (keys) => {
      for (const m of metas) {
        const prop = (m.property || m.name || '').toLowerCase();
        if (keys.includes(prop) && m.content) {
          return decodeHtmlEntities(m.content);
        }
      }
      return '';
    };

    // 1. Title (og:title -> twitter:title -> <meta name="title"> -> <title>)
    let title = findMeta(['og:title', 'twitter:title', 'title']);
    if (!title) {
      const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleTagMatch && titleTagMatch[1]) {
        title = decodeHtmlEntities(titleTagMatch[1].replace(/<[^>]+>/g, '').trim());
      }
    }
    result.title = title;

    // 2. Description
    result.description = findMeta(['og:description', 'twitter:description', 'description']);

    // 3. Image (og:image -> twitter:image -> link image_src)
    let rawImg = findMeta(['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
    if (!rawImg) {
      const linkImgMatch = html.match(/<link\s+[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["']/i) ||
                           html.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']image_src["']/i);
      if (linkImgMatch && linkImgMatch[1]) {
        rawImg = linkImgMatch[1].trim();
      }
    }
    if (rawImg) {
      try {
        result.image = new URL(rawImg, targetUrl).href;
      } catch (_) {
        result.image = rawImg;
      }
    }

    // 4. Site Name
    const siteName = findMeta(['og:site_name', 'application-name']);
    if (siteName) {
      result.siteName = siteName;
    }

    // 5. Favicon from <link rel="icon">
    const iconMatch = html.match(/<link\s+[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*href=["']([^"']+)["']/i) ||
                      html.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:shortcut\s+)?icon["']/i);
    if (iconMatch && iconMatch[1]) {
      try {
        result.favicon = new URL(iconMatch[1].trim(), targetUrl).href;
      } catch (_) {}
    }
  } catch (_) {}

  return result;
}

/**
 * Fetch a public web page and return a small, text-only preview.
 * No images are proxied, so the worker can't be used as an open image proxy.
 */
export async function getLinkPreview(target) {
  let parsed;
  try { parsed = new URL(target); } catch { return { error: 'invalid' }; }
  if (!['http:', 'https:'].includes(parsed.protocol) || isPrivateOrLocalHost(parsed.hostname)) return { error: 'blocked' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await safeFetchWithRedirects(parsed.href, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SyncPadPreview/2.0)',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'
      }
    });
    const site = parsed.hostname.replace(/^www\./i, '');
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || !type.includes('html')) return { title: '', site, desc: '' };
    // Read at most 512 KB of HTML
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < 524288) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    try { reader.cancel(); } catch {}
    const html = new TextDecoder().decode(concat(chunks));
    const meta = extractHtmlMetadata(html, parsed.href);
    return {
      title: String(meta.title || '').slice(0, 200),
      site: String(meta.siteName || site).slice(0, 80),
      desc: String(meta.description || '').slice(0, 300)
    };
  } catch {
    return { error: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
