// Link-preview helpers (SSRF-safe fetch + HTML metadata parsing + specialized oEmbed for YouTube, X, Instagram, Facebook, etc.)
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
    favicon: '',
    isFavicon: false
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
    if (title) {
      // Clean up common trailing clutter like " - YouTube", " | Facebook", " / X", etc.
      title = title.replace(/\s*[-–|•]\s*(?:YouTube|Twitter|X(?:\s*\(formerly Twitter\))?|Facebook|Instagram|Wikipedia|Reddit|TikTok)$/i, '').trim();
    }
    result.title = title;

    // 2. Description
    result.description = findMeta(['og:description', 'twitter:description', 'description']);

    // 3. Image (og:image -> twitter:image -> link image_src)
    let rawImg = findMeta(['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']);
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
        result.isFavicon = false;
      } catch (_) {
        result.image = rawImg;
        result.isFavicon = false;
      }
    }

    // 4. Site Name
    const siteName = findMeta(['og:site_name', 'application-name']);
    if (siteName) {
      result.siteName = siteName;
    }

    // 5. Favicon from <link rel="icon">
    const iconMatch = html.match(/<link\s+[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*href=["']([^"']+)["']/i) ||
                      html.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:shortcut\s+)?icon["']/i) ||
                      html.match(/<link\s+[^>]*rel=["']apple-touch-icon(?:-precomposed)?["'][^>]*href=["']([^"']+)["']/i) ||
                      html.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']apple-touch-icon(?:-precomposed)?["']/i);
    if (iconMatch && iconMatch[1]) {
      try {
        result.favicon = new URL(iconMatch[1].trim(), targetUrl).href;
      } catch (_) {}
    }
    if (!result.image && result.favicon) {
      result.isFavicon = true;
    }
  } catch (_) {}

  return result;
}

/**
 * Handle major platforms with dedicated APIs/oEmbed for fast, reliable titles and clean thumbnails
 */
async function getSpecialPreview(parsed, opts, signal) {
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const href = parsed.href;

  // 1. YouTube (youtube.com & youtu.be)
  const ytMatch = href.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
  if (ytMatch) {
    const vid = ytMatch[1];
    // Use clean 16:9 mqdefault.jpg (NO black letterbox bars, unlike hqdefault.jpg)
    const mqThumb = `https://img.youtube.com/vi/${vid}/mqdefault.jpg`;
    let title = '';
    let author = '';
    try {
      const oeRes = await safeFetchWithRedirects(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vid}&format=json`, { signal });
      if (oeRes.ok) {
        const oe = await oeRes.json();
        title = decodeHtmlEntities(oe.title || '').replace(/\s*-\s*YouTube$/i, '').trim();
        author = oe.author_name || '';
      }
    } catch (_) {}

    const out = {
      title: title || 'YouTube Video',
      site: 'YouTube',
      desc: author ? `By ${author}` : 'YouTube Video',
      imageUrl: mqThumb,
      isFavicon: false
    };
    if (opts.image) {
      out.image = (await smallImage(mqThumb, signal)) || mqThumb;
    }
    return out;
  }

  // 2. Twitter / X
  const twMatch = href.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)\/status\/(\d+)/i);
  if (twMatch) {
    const user = twMatch[1];
    const tid = twMatch[2];
    try {
      const fxRes = await safeFetchWithRedirects(`https://api.fxtwitter.com/${user}/status/${tid}`, { signal });
      if (fxRes.ok) {
        const fx = await fxRes.json();
        if (fx && fx.tweet) {
          const author = fx.tweet.author?.name || user;
          const text = (fx.tweet.text || '').replace(/\s*https:\/\/t\.co\/\S+/g, '').trim();
          const photo = fx.tweet.media?.photos?.[0]?.url || fx.tweet.media?.videos?.[0]?.thumbnail_url;
          const out = {
            title: text ? `${author}: "${text.length > 100 ? text.slice(0, 100) + '…' : text}"` : `${author} on X`,
            site: 'X (Twitter)',
            desc: text,
            imageUrl: photo || '',
            isFavicon: !photo
          };
          if (opts.image && photo) {
            out.image = (await smallImage(photo, signal)) || photo;
          }
          return out;
        }
      }
    } catch (_) {}
    // Fallback: publish.twitter.com oembed
    try {
      const pubRes = await safeFetchWithRedirects(`https://publish.twitter.com/oembed?url=${encodeURIComponent(href)}`, { signal });
      if (pubRes.ok) {
        const pub = await pubRes.json();
        const author = pub.author_name || user;
        const textMatch = pub.html && pub.html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        const text = textMatch ? decodeHtmlEntities(textMatch[1].replace(/<[^>]+>/g, '').trim()) : '';
        return {
          title: text ? `${author}: "${text.length > 100 ? text.slice(0, 100) + '…' : text}"` : `${author} on X`,
          site: 'X (Twitter)',
          desc: text,
          isFavicon: true
        };
      }
    } catch (_) {}
  }

  // 3. Instagram
  if (host === 'instagram.com') {
    const reelMatch = href.match(/instagram\.com\/(?:reel|reels)\/([a-zA-Z0-9_-]+)/i);
    const postMatch = href.match(/instagram\.com\/p\/([a-zA-Z0-9_-]+)/i);
    const userMatch = href.match(/instagram\.com\/([a-zA-Z0-9_.-]+)\/?(?:$|\?)/i);
    let fallbackTitle = 'Instagram';
    if (reelMatch) fallbackTitle = 'Instagram Reel';
    else if (postMatch) fallbackTitle = 'Instagram Post';
    else if (userMatch && !['explore', 'reels', 'stories', 'direct'].includes(userMatch[1])) {
      fallbackTitle = `@${userMatch[1]} on Instagram`;
    }
    // Attempt fetch with bot UA
    try {
      const res = await safeFetchWithRedirects(href, {
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'
        }
      });
      if (res.ok) {
        const html = await res.text();
        const meta = extractHtmlMetadata(html, href);
        let title = meta.title;
        if (!title || title.toLowerCase() === 'instagram') title = fallbackTitle;
        const out = {
          title: String(title).slice(0, 200),
          site: 'Instagram',
          desc: String(meta.description || '').slice(0, 300),
          imageUrl: meta.image || '',
          isFavicon: !meta.image
        };
        if (opts.image && meta.image) {
          out.image = (await smallImage(meta.image, signal)) || meta.image;
        }
        return out;
      }
    } catch (_) {}
    return {
      title: fallbackTitle,
      site: 'Instagram',
      desc: '',
      isFavicon: true
    };
  }

  // 4. Facebook
  if (host.includes('facebook.com') || host === 'fb.watch') {
    let fallbackTitle = 'Facebook Post';
    if (href.includes('/videos/') || host === 'fb.watch') fallbackTitle = 'Facebook Video';
    try {
      const res = await safeFetchWithRedirects(href, {
        signal,
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.html)',
          'Accept': 'text/html'
        }
      });
      if (res.ok) {
        const html = await res.text();
        const meta = extractHtmlMetadata(html, href);
        let title = meta.title;
        if (!title || title.toLowerCase() === 'facebook') title = fallbackTitle;
        const out = {
          title: String(title).slice(0, 200),
          site: 'Facebook',
          desc: String(meta.description || '').slice(0, 300),
          imageUrl: meta.image || '',
          isFavicon: !meta.image
        };
        if (opts.image && meta.image) {
          out.image = (await smallImage(meta.image, signal)) || meta.image;
        }
        return out;
      }
    } catch (_) {}
    return {
      title: fallbackTitle,
      site: 'Facebook',
      desc: '',
      isFavicon: true
    };
  }

  // 5. Reddit
  if (host.includes('reddit.com')) {
    try {
      const rdRes = await safeFetchWithRedirects(`https://www.reddit.com/oembed?url=${encodeURIComponent(href)}`, { signal });
      if (rdRes.ok) {
        const rd = await rdRes.json();
        if (rd && rd.title) {
          return {
            title: decodeHtmlEntities(rd.title),
            site: 'Reddit',
            desc: rd.author_name ? `Posted by u/${rd.author_name}` : '',
            isFavicon: true
          };
        }
      }
    } catch (_) {}
  }

  // 6. Vimeo
  if (host.includes('vimeo.com')) {
    try {
      const vmRes = await safeFetchWithRedirects(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(href)}`, { signal });
      if (vmRes.ok) {
        const vm = await vmRes.json();
        const out = {
          title: decodeHtmlEntities(vm.title || 'Vimeo Video'),
          site: 'Vimeo',
          desc: vm.author_name ? `By ${vm.author_name}` : '',
          imageUrl: vm.thumbnail_url || '',
          isFavicon: false
        };
        if (opts.image && vm.thumbnail_url) {
          out.image = (await smallImage(vm.thumbnail_url, signal)) || vm.thumbnail_url;
        }
        return out;
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Fetch a public web page and return metadata + preview picture
 */
export async function getLinkPreview(target, opts = {}) {
  let parsed;
  try { parsed = new URL(target); } catch { return { error: 'invalid' }; }
  if (!['http:', 'https:'].includes(parsed.protocol) || isPrivateOrLocalHost(parsed.hostname)) return { error: 'blocked' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    // Check specialized platform handlers first (YouTube, X, Instagram, Facebook, Reddit, etc.)
    const special = await getSpecialPreview(parsed, opts, controller.signal);
    if (special && special.title) {
      return special;
    }

    const res = await safeFetchWithRedirects(parsed.href, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 (compatible; SyncPad/2.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const site = parsed.hostname.replace(/^www\./i, '');
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || !type.includes('html')) {
      const fallbackTitle = parsed.pathname.length > 1 ? `${parsed.pathname.replace(/^\/|\/$/g, '').slice(0, 60)} · ${site}` : site;
      return { title: fallbackTitle, site, desc: '', isFavicon: true };
    }

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
    const out = {
      title: String(meta.title || site).slice(0, 200),
      site: String(meta.siteName || site).slice(0, 80),
      desc: String(meta.description || '').slice(0, 300),
      imageUrl: meta.image || '',
      isFavicon: !meta.image
    };
    if (opts.image && meta.image) out.image = (await smallImage(meta.image, controller.signal)) || meta.image;
    if (opts.image && !out.image && meta.favicon) {
      out.image = await smallImage(meta.favicon, controller.signal);
      out.isFavicon = true;
    }
    return out;
  } catch {
    const site = parsed.hostname.replace(/^www\./i, '');
    return { title: site, site, desc: '', isFavicon: true };
  } finally {
    clearTimeout(timer);
  }
}

/** The page's preview picture as a data URL (only images, at most 600 KB) — the app shrinks it to a thumbnail */
async function smallImage(src, signal) {
  try {
    const u = new URL(src);
    if (!['http:', 'https:'].includes(u.protocol) || isPrivateOrLocalHost(u.hostname)) return '';
    const res = await safeFetchWithRedirects(u.href, {
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 (compatible; SyncPad/2.0)',
        'Accept': 'image/*'
      }
    });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !/^image\/(png|jpe?g|webp|gif|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(type)) return '';
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 614400) { try { reader.cancel(); } catch {} return ''; }
      chunks.push(value);
    }
    const bytes = concat(chunks);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(bin)}`;
  } catch { return ''; }
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
