// YouTube stream resolver and proxy helper for direct one-tap audio/video downloads.

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const STREAM_CACHE_TTL_S = 180;
const memStreamCache = new Map();

const INNERTUBE_CLIENTS = [
  {
    name: 'ANDROID',
    id: '3',
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
    context: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
        androidSdkVersion: 34,
        hl: 'en',
        gl: 'US'
      }
    }
  },
  {
    name: 'ANDROID_VR',
    id: '28',
    ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    context: {
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.60.19',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        osName: 'Android',
        osVersion: '12L',
        androidSdkVersion: 32,
        hl: 'en',
        gl: 'US'
      }
    }
  },
  {
    name: 'IOS',
    id: '5',
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
    context: {
      client: {
        clientName: 'IOS',
        clientVersion: '20.10.4',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '18.3.2.22D82',
        hl: 'en',
        gl: 'US'
      }
    }
  }
];

export function extractYoutubeId(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    const h = u.hostname.replace(/^www\./i, '').replace(/^m\./i, '').replace(/^music\./i, '').toLowerCase();
    let id = '';
    if (h === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
      else {
        const parts = u.pathname.split('/').filter(Boolean);
        if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1] || '';
      }
    }
    return YT_ID_RE.test(id) ? id : '';
  } catch {
    return '';
  }
}

export function sanitizeFilename(name, fallback = 'youtube') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  return cleaned || fallback;
}

function pickBestStreams(streamingData) {
  const fmts = Array.isArray(streamingData?.formats) ? streamingData.formats : [];
  const adapt = Array.isArray(streamingData?.adaptiveFormats) ? streamingData.adaptiveFormats : [];

  const directMuxedMp4 = fmts
    .filter((f) => f && f.url && /video\/mp4/i.test(f.mimeType || ''))
    .sort((a, b) => (Number(b.height || 0) - Number(a.height || 0)) || (Number(b.bitrate || 0) - Number(a.bitrate || 0)));

  const anyMuxed = directMuxedMp4.length
    ? directMuxedMp4
    : fmts.filter((f) => f && f.url).sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));

  const audioMp4 = adapt
    .filter((f) => f && f.url && /^audio\/mp4/i.test(f.mimeType || ''))
    .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));

  const audioAny = audioMp4.length
    ? audioMp4
    : adapt.filter((f) => f && f.url && /^audio\//i.test(f.mimeType || '')).sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));

  return {
    video: anyMuxed[0] || null,
    audio: audioAny[0] || null
  };
}

async function fetchVisitorData(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/embed/${videoId}`, {
      signal: AbortSignal.timeout(4000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!res.ok) return '';
    const html = await res.text();
    const m = /"visitorData"\s*:\s*"([^"]+)"/.exec(html);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function cacheKeyUrl(videoId) {
  return `https://yt-cache.internal/v1/${videoId}`;
}

async function readStreamCache(videoId) {
  const mem = memStreamCache.get(videoId);
  if (mem) {
    if (Date.now() < mem.exp) return mem.data;
    memStreamCache.delete(videoId);
  }
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      const hit = await caches.default.match(cacheKeyUrl(videoId));
      if (hit) {
        const data = await hit.json();
        memStreamCache.set(videoId, { data, exp: Date.now() + STREAM_CACHE_TTL_S * 1000 });
        return data;
      }
    }
  } catch {}
  return null;
}

async function writeStreamCache(videoId, data) {
  memStreamCache.set(videoId, { data, exp: Date.now() + STREAM_CACHE_TTL_S * 1000 });
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      await caches.default.put(
        cacheKeyUrl(videoId),
        new Response(JSON.stringify(data), {
          headers: {
            'content-type': 'application/json',
            'cache-control': `public, max-age=${STREAM_CACHE_TTL_S}`
          }
        })
      );
    }
  } catch {}
}

async function invalidateStreamCache(videoId) {
  memStreamCache.delete(videoId);
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      await caches.default.delete(cacheKeyUrl(videoId));
    }
  } catch {}
}

async function fetchInnerTube(videoId, client, visitorData) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': client.ua,
    'X-YouTube-Client-Name': client.id,
    'X-YouTube-Client-Version': client.context.client.clientVersion
  };
  if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

  const clientCtx = visitorData
    ? { ...client.context.client, visitorData }
    : client.context.client;

  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers,
    body: JSON.stringify({
      videoId,
      context: { client: clientCtx },
      contentCheckOk: true,
      racyCheckOk: true
    })
  });
  if (!res.ok) return { error: `http_${res.status}` };
  const data = await res.json();
  const status = data?.playabilityStatus?.status || 'UNKNOWN';
  if (status !== 'OK') {
    return { error: status, reason: data?.playabilityStatus?.reason || '' };
  }
  const { video, audio } = pickBestStreams(data.streamingData);
  const title = data?.videoDetails?.title || '';
  return { client: client.name, title, video, audio };
}

function toStreamMeta(fmt, ua, clientName) {
  return {
    client: clientName,
    url: fmt.url,
    mime: (fmt.mimeType || 'video/mp4').split(';')[0],
    size: Number(fmt.contentLength || 0) || null,
    ua
  };
}

export async function resolveYoutubeStreams(videoId, opts = {}) {
  if (!YT_ID_RE.test(videoId)) return { error: 'bad_id' };
  if (!opts.bypassCache) {
    const cached = await readStreamCache(videoId);
    if (cached && (cached.videos?.length || cached.audios?.length)) return cached;
  }

  const visitorData = await fetchVisitorData(videoId);
  let lastErr = '';
  const best = { title: '', videos: [], audios: [] };

  // Query ANDROID (muxed MP4) + IOS (reliable adaptive audio) first; fall back to ANDROID_VR only if needed
  const primary = INNERTUBE_CLIENTS.filter((c) => c.name === 'ANDROID' || c.name === 'IOS');
  const backup = INNERTUBE_CLIENTS.filter((c) => c.name !== 'ANDROID' && c.name !== 'IOS');

  const ingest = (client, r) => {
    if (!r || r.error) {
      if (r?.reason || r?.error) lastErr = r.reason || r.error;
      return;
    }
    if (!best.title && r.title) best.title = r.title;
    if (r.video) best.videos.push(toStreamMeta(r.video, client.ua, client.name));
    if (r.audio) best.audios.push(toStreamMeta(r.audio, client.ua, client.name));
  };

  const primaryRes = await Promise.allSettled(primary.map((c) => fetchInnerTube(videoId, c, visitorData)));
  primaryRes.forEach((res, i) => {
    if (res.status === 'fulfilled') ingest(primary[i], res.value);
    else lastErr = String(res.reason?.message || res.reason || lastErr);
  });

  if (!best.videos.length || !best.audios.length) {
    for (const client of backup) {
      try {
        ingest(client, await fetchInnerTube(videoId, client, visitorData));
      } catch (e) {
        lastErr = String((e && e.message) || e);
      }
    }
  }

  // Prefer ANDROID muxed video for video; prefer IOS audio first since ANDROID adaptive often 403s from edge IPs
  best.audios.sort((a, b) => (a.client === 'IOS' ? -1 : b.client === 'IOS' ? 1 : 0));
  best.video = best.videos[0] || null;
  best.audio = best.audios[0] || null;

  if (!best.videos.length && !best.audios.length) {
    return { error: 'unavailable', reason: lastErr || 'Could not extract stream' };
  }
  await writeStreamCache(videoId, best);
  return best;
}

const FIRST_CHUNK = 4 * 1024 * 1024;
const NEXT_CHUNK = 8 * 1024 * 1024;

function parseClientRange(header) {
  const m = /^bytes=(\d+)-(\d+)?$/i.exec(String(header || '').trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] != null ? Number(m[2]) : null;
  if (!Number.isFinite(start) || (end != null && (!Number.isFinite(end) || end < start))) return null;
  return { start, end };
}

function parseContentRange(cr) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(cr || '').trim());
  if (!m) return null;
  return {
    start: Number(m[1]),
    end: Number(m[2]),
    total: m[3] === '*' ? null : Number(m[3])
  };
}

export async function proxyYoutubeDownload(request, url) {
  const raw = url.searchParams.get('v') || url.searchParams.get('url') || '';
  const videoId = YT_ID_RE.test(raw) ? raw : extractYoutubeId(raw);
  if (!videoId) return new Response(JSON.stringify({ error: 'bad_video' }), { status: 400, headers: { 'content-type': 'application/json' } });

  const mode = url.searchParams.get('mode') === 'audio' ? 'audio' : 'video';
  let info = await resolveYoutubeStreams(videoId);
  if (info.error) {
    return new Response(JSON.stringify({ error: info.error, reason: info.reason || '' }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  const getCandidates = (resolved) => {
    const vids = Array.isArray(resolved.videos) ? resolved.videos : (resolved.video ? [resolved.video] : []);
    const auds = Array.isArray(resolved.audios) ? resolved.audios : (resolved.audio ? [resolved.audio] : []);
    return mode === 'audio' ? [...auds, ...vids] : vids;
  };

  let candidates = getCandidates(info);
  let stream = candidates[0] || null;
  if (!stream || !stream.url) {
    return new Response(JSON.stringify({
      error: mode === 'video' ? 'no_video_stream' : 'no_stream',
      reason: mode === 'video' ? 'No playable MP4 video stream found for this video.' : 'No playable stream found for this video.'
    }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  const extFor = (s) => (/webm/i.test(s.mime) ? 'webm' : /^video\/mp4/i.test(s.mime) ? 'mp4' : mode === 'audio' ? 'm4a' : 'mp4');
  let ext = extFor(stream);
  const title = sanitizeFilename(url.searchParams.get('title') || info.title, `youtube-${videoId}`);

  if (url.searchParams.has('info')) {
    return new Response(JSON.stringify({
      ok: true,
      id: videoId,
      title,
      mime: stream.mime,
      ext,
      size: stream.size
    }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  const clientRange = parseClientRange(request.headers.get('range'));
  const reqStart = clientRange ? clientRange.start : 0;
  const reqEnd = clientRange ? clientRange.end : null;
  const method = request.method === 'HEAD' ? 'HEAD' : 'GET';

  const openFirstChunk = async (s) => {
    const sUa = s.ua || INNERTUBE_CLIENTS[0].ua;
    let firstEnd = reqStart + FIRST_CHUNK - 1;
    if (reqEnd != null) firstEnd = Math.min(firstEnd, reqEnd);
    if (s.size) firstEnd = Math.min(firstEnd, s.size - 1);
    const res = await fetch(s.url, {
      method,
      headers: { 'User-Agent': sUa, 'Range': `bytes=${reqStart}-${firstEnd}` }
    });
    return { res, ua: sUa };
  };

  const tryCandidates = async (list) => {
    let last = { res: null, ua: INNERTUBE_CLIENTS[0].ua, stream: list[0] };
    for (const cand of list) {
      if (!cand?.url) continue;
      if (last.res) { try { await last.res.body?.cancel(); } catch {} }
      const attempt = await openFirstChunk(cand);
      last = { ...attempt, stream: cand };
      if (attempt.res.ok || attempt.res.status === 206) return last;
    }
    return last;
  };

  let picked = await tryCandidates(candidates);
  if ((!picked.res || (!picked.res.ok && picked.res.status !== 206)) && (picked.res?.status === 403 || picked.res?.status === 410)) {
    try { await picked.res.body?.cancel(); } catch {}
    await invalidateStreamCache(videoId);
    const fresh = await resolveYoutubeStreams(videoId, { bypassCache: true });
    if (!fresh.error) {
      const freshList = getCandidates(fresh);
      if (freshList.length) {
        info = fresh;
        picked = await tryCandidates(freshList);
      }
    }
  }
  const up = picked.res;
  const ua = picked.ua;
  stream = picked.stream || stream;
  ext = extFor(stream);
  if (!up || (!up.ok && up.status !== 206)) {
    const st = up ? up.status : 502;
    return new Response(JSON.stringify({ error: 'upstream', status: st, reason: `YouTube stream returned HTTP ${st}` }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  const h = new Headers();
  h.set('content-type', stream.mime || (mode === 'audio' ? 'audio/mp4' : 'video/mp4'));
  h.set('accept-ranges', 'bytes');
  h.set('cache-control', 'no-store');
  if (!url.searchParams.has('inline')) {
    const asciiName = `${title}.${ext}`.replace(/[^\x20-\x7e]/g, '_');
    const utf8Name = encodeURIComponent(`${title}.${ext}`);
    h.set('content-disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`);
  }

  const cr = parseContentRange(up.headers.get('content-range'));
  if (up.status === 200 || !cr || cr.total == null) {
    const len = up.headers.get('content-length');
    if (len) h.set('content-length', len);
    return new Response(method === 'HEAD' ? null : up.body, { status: up.status, headers: h });
  }

  const totalSize = cr.total;
  const finalEnd = reqEnd != null ? Math.min(reqEnd, totalSize - 1) : totalSize - 1;
  const outLen = Math.max(0, finalEnd - reqStart + 1);
  h.set('content-length', String(outLen));
  if (clientRange) h.set('content-range', `bytes ${reqStart}-${finalEnd}/${totalSize}`);
  const outStatus = clientRange ? 206 : 200;

  if (method === 'HEAD') {
    try { await up.body?.cancel(); } catch {}
    return new Response(null, { status: outStatus, headers: h });
  }
  if (cr.end >= finalEnd) {
    return new Response(up.body, { status: outStatus, headers: h });
  }

  // Pump subsequent byte ranges so googlevideo.com delivers full speed (~2-3 MB/s) instead of throttling single GETs
  let curReader = up.body.getReader();
  let nextOffset = cr.end + 1;
  const body = new ReadableStream({
    async pull(controller) {
      while (true) {
        if (curReader) {
          const { done, value } = await curReader.read();
          if (!done) {
            if (value && value.byteLength) {
              controller.enqueue(value);
              return;
            }
            continue;
          }
          curReader = null;
        }
        if (nextOffset > finalEnd) {
          controller.close();
          return;
        }
        const chunkEnd = Math.min(finalEnd, nextOffset + NEXT_CHUNK - 1);
        const rNext = await fetch(stream.url, {
          headers: { 'User-Agent': ua, 'Range': `bytes=${nextOffset}-${chunkEnd}` }
        });
        if (!rNext.ok && rNext.status !== 206) {
          controller.error(new Error(`Upstream chunk failed: HTTP ${rNext.status}`));
          return;
        }
        const ncr = parseContentRange(rNext.headers.get('content-range'));
        const gotEnd = ncr ? ncr.end : chunkEnd;
        nextOffset = gotEnd + 1;
        curReader = rNext.body.getReader();
      }
    },
    async cancel() {
      try { await curReader?.cancel(); } catch {}
      curReader = null;
    }
  });

  return new Response(body, { status: outStatus, headers: h });
}
