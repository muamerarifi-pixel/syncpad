// YouTube stream resolver and proxy helper for direct one-tap audio/video downloads.

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const INNERTUBE_CLIENTS = [
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

async function fetchInnerTube(videoId, client) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': client.ua,
      'X-YouTube-Client-Name': client.id,
      'X-YouTube-Client-Version': client.context.client.clientVersion
    },
    body: JSON.stringify({
      videoId,
      context: client.context,
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

export async function resolveYoutubeStreams(videoId) {
  if (!YT_ID_RE.test(videoId)) return { error: 'bad_id' };
  let lastErr = '';
  let best = { title: '', video: null, audio: null };

  for (const client of INNERTUBE_CLIENTS) {
    try {
      const r = await fetchInnerTube(videoId, client);
      if (r.error) {
        lastErr = r.reason || r.error;
        continue;
      }
      if (!best.title && r.title) best.title = r.title;
      if (!best.video && r.video) best.video = { url: r.video.url, mime: (r.video.mimeType || 'video/mp4').split(';')[0], size: Number(r.video.contentLength || 0) || null, ua: client.ua };
      if (!best.audio && r.audio) best.audio = { url: r.audio.url, mime: (r.audio.mimeType || 'audio/mp4').split(';')[0], size: Number(r.audio.contentLength || 0) || null, ua: client.ua };
      if (best.video && best.audio) break;
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }

  if (!best.video && !best.audio) {
    return { error: 'unavailable', reason: lastErr || 'Could not extract stream' };
  }
  return best;
}

export async function proxyYoutubeDownload(request, url) {
  const raw = url.searchParams.get('v') || url.searchParams.get('url') || '';
  const videoId = YT_ID_RE.test(raw) ? raw : extractYoutubeId(raw);
  if (!videoId) return new Response(JSON.stringify({ error: 'bad_video' }), { status: 400, headers: { 'content-type': 'application/json' } });

  const mode = url.searchParams.get('mode') === 'audio' ? 'audio' : 'video';
  const info = await resolveYoutubeStreams(videoId);
  if (info.error) {
    return new Response(JSON.stringify({ error: info.error, reason: info.reason || '' }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  const stream = mode === 'audio' ? (info.audio || info.video) : (info.video || info.audio);
  if (!stream || !stream.url) {
    return new Response(JSON.stringify({ error: 'no_stream' }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  const ext = mode === 'audio'
    ? (/webm/i.test(stream.mime) ? 'webm' : 'm4a')
    : (/webm/i.test(stream.mime) ? 'webm' : 'mp4');
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

  const upstreamHeaders = {
    'User-Agent': stream.ua || INNERTUBE_CLIENTS[0].ua
  };
  const range = request.headers.get('range');
  if (range) upstreamHeaders['Range'] = range;

  const up = await fetch(stream.url, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: upstreamHeaders
  });
  if (!up.ok && up.status !== 206) {
    return new Response(JSON.stringify({ error: 'upstream', status: up.status }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  const h = new Headers();
  h.set('content-type', stream.mime || (mode === 'audio' ? 'audio/mp4' : 'video/mp4'));
  const len = up.headers.get('content-length');
  if (len) h.set('content-length', len);
  const cr = up.headers.get('content-range');
  if (cr) h.set('content-range', cr);
  h.set('accept-ranges', 'bytes');
  h.set('cache-control', 'no-store');
  if (!url.searchParams.has('inline')) {
    const asciiName = `${title}.${ext}`.replace(/[^\x20-\x7e]/g, '_');
    const utf8Name = encodeURIComponent(`${title}.${ext}`);
    h.set('content-disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`);
  }
  return new Response(request.method === 'HEAD' ? null : up.body, { status: up.status, headers: h });
}
