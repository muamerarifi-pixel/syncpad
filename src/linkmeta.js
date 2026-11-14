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

    // 3. Image (og:image -> twitter:image -> itemprop=image -> link image_src -> JSON-LD image)
    let rawImg = findMeta(['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image:src', 'twitter:image', 'image']);
    if (!rawImg) {
      const linkImgMatch = html.match(/<link\s+[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["']/i) ||
                           html.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']image_src["']/i);
      if (linkImgMatch && linkImgMatch[1]) {
        rawImg = decodeHtmlEntities(linkImgMatch[1].trim());
      }
    }
    if (!rawImg) {
      const ldMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
      if (ldMatch && ldMatch[1]) {
        const imgField = ldMatch[1].match(/"image"\s*:\s*(?:"(https?:\/\/[^"]+)"|\[\s*"(https?:\/\/[^"]+)"|\{\s*[^}]*"url"\s*:\s*"(https?:\/\/[^"]+)")/i);
        const foundLd = imgField && (imgField[1] || imgField[2] || imgField[3]);
        if (foundLd) rawImg = decodeHtmlEntities(foundLd.trim());
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
        result.favicon = new URL(decodeHtmlEntities(iconMatch[1].trim()), targetUrl).href;
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
      out.image = await smallImage(mqThumb, signal, parsed.origin + '/');
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
            out.image = await smallImage(photo, signal, parsed.origin + '/');
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
          out.image = await smallImage(meta.image, signal, parsed.origin + '/');
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
          out.image = await smallImage(meta.image, signal, parsed.origin + '/');
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
          const thumbUrl = rd.thumbnail_url ? decodeHtmlEntities(String(rd.thumbnail_url)) : '';
          const out = {
            title: decodeHtmlEntities(rd.title),
            site: 'Reddit',
            desc: rd.author_name ? `Posted by u/${rd.author_name}` : '',
            imageUrl: thumbUrl,
            isFavicon: !thumbUrl
          };
          if (opts.image && thumbUrl) {
            out.image = await smallImage(thumbUrl, signal, parsed.origin + '/');
          }
          return out;
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
          out.image = await smallImage(vm.thumbnail_url, signal, parsed.origin + '/');
        }
        return out;
      }
    } catch (_) {}
  }

  // 7. TikTok
  if (host.includes('tiktok.com')) {
    try {
      const tkRes = await safeFetchWithRedirects(`https://www.tiktok.com/oembed?url=${encodeURIComponent(href)}`, { signal });
      if (tkRes.ok) {
        const tk = await tkRes.json();
        if (tk && (tk.title || tk.author_name)) {
          const thumbUrl = tk.thumbnail_url ? decodeHtmlEntities(String(tk.thumbnail_url)) : '';
          const out = {
            title: decodeHtmlEntities(tk.title || `TikTok by ${tk.author_name}`),
            site: 'TikTok',
            desc: tk.author_name ? `By ${tk.author_name}` : '',
            imageUrl: thumbUrl,
            isFavicon: !thumbUrl
          };
          if (opts.image && thumbUrl) {
            out.image = await smallImage(thumbUrl, signal, parsed.origin + '/');
          }
          return out;
        }
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
  const timer = setTimeout(() => controller.abort(), 10000);
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
    if (opts.image && meta.image) out.image = await smallImage(meta.image, controller.signal, parsed.origin + '/');
    if (opts.image && !out.image && !out.imageUrl && meta.favicon) {
      out.image = await smallImage(meta.favicon, controller.signal, parsed.origin + '/');
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
function detectImageMime(bytes) {
  if (!bytes || bytes.length < 12) return '';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'image/x-icon';
  return '';
}

async function smallImage(src, signal, referer) {
  try {
    const u = new URL(src);
    if (!['http:', 'https:'].includes(u.protocol) || isPrivateOrLocalHost(u.hostname)) return '';
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 (compatible; SyncPad/2.0)',
      'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8'
    };
    if (referer) headers['Referer'] = referer;
    const res = await safeFetchWithRedirects(u.href, { signal, headers });
    if (!res.ok) return '';
    let type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const isAllowedImage = /^image\/(png|jpe?g|webp|gif|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(type);
    const maybeBinary = !type || type === 'application/octet-stream' || type === 'binary/octet-stream';
    if (!isAllowedImage && !maybeBinary) return '';
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 2621440) { try { reader.cancel(); } catch {} return ''; }
      chunks.push(value);
    }
    const bytes = concat(chunks);
    if (!isAllowedImage) {
      type = detectImageMime(bytes);
      if (!type) return '';
    }
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
