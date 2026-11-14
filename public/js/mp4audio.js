// Streaming ISO-BMFF (.mp4/.m4a) audio extractor and WebCodecs MP3 converter.
// Keeps peak memory low on long (30m–3h+) recordings by streaming 8 MB Range chunks
// and discarding video frames immediately as each chunk arrives.

const RANGE_CHUNK = 8 * 1024 * 1024;
const HEAD_PROBE = 2 * 1024 * 1024;

function readFourCC(buf, off) {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

function readU32(dv, off) {
  return dv.getUint32(off);
}

function readU64(dv, off) {
  return dv.getUint32(off) * 4294967296 + dv.getUint32(off + 4);
}

function listBoxes(buf, start, end) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let sz = readU32(dv, p);
    let hdr = 8;
    const type = readFourCC(buf, p + 4);
    if (sz === 1) {
      if (p + 16 > end) break;
      sz = readU64(dv, p + 8);
      hdr = 16;
    } else if (sz === 0) {
      sz = end - p;
    }
    if (sz < hdr || p + sz > end) break;
    out.push({ type, start: p, size: sz, dataStart: p + hdr, end: p + sz });
    p += sz;
  }
  return out;
}

function makeBox(type, ...parts) {
  let len = 8;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let pos = 8;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

function makeM4aFtyp() {
  const out = new Uint8Array(28);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 28);
  out.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
  out.set([0x4d, 0x34, 0x41, 0x20], 8); // 'M4A '
  dv.setUint32(12, 0);
  out.set([0x4d, 0x34, 0x41, 0x20], 16); // 'M4A '
  out.set([0x6d, 0x70, 0x34, 0x32], 20); // 'mp42'
  out.set([0x69, 0x73, 0x6f, 0x6d], 24); // 'isom'
  return out;
}

// ISO-14496-1 descriptor length (7-bit continuation bytes)
function readDescLen(buf, pos, end) {
  let len = 0;
  let i = 0;
  while (pos < end && i < 4) {
    const b = buf[pos++];
    len = (len << 7) | (b & 0x7f);
    i++;
    if ((b & 0x80) === 0) break;
  }
  return { len, next: pos };
}

function parseEsdsConfig(buf, start, end) {
  // FullBox (4 bytes version+flags) precedes ES_Descriptor
  let p = start + 4;
  if (p >= end || buf[p++] !== 0x03) return null;
  const es = readDescLen(buf, p, end);
  p = es.next + 2; // ES_ID
  if (p >= end) return null;
  const flags = buf[p++];
  if (flags & 0x80) p += 2; // dependsOn_ES_ID
  if (flags & 0x40 && p < end) p += 1 + buf[p]; // URL
  if (flags & 0x20) p += 2; // OCR_ES_ID

  const descEnd = Math.min(end, es.next + es.len);
  while (p < descEnd) {
    const tag = buf[p++];
    const dl = readDescLen(buf, p, descEnd);
    p = dl.next;
    const subEnd = Math.min(descEnd, p + dl.len);
    if (tag === 0x04 && subEnd - p >= 13) {
      let dp = p + 13; // DecoderConfigDescriptor header
      while (dp < subEnd) {
        const subTag = buf[dp++];
        const sdl = readDescLen(buf, dp, subEnd);
        dp = sdl.next;
        if (subTag === 0x05) {
          return buf.slice(dp, Math.min(subEnd, dp + sdl.len));
        }
        dp += sdl.len;
      }
    }
    p = subEnd;
  }
  return null;
}

export function parseMp4AudioHeader(headBuf) {
  const dv = new DataView(headBuf.buffer, headBuf.byteOffset, headBuf.byteLength);
  const top = listBoxes(headBuf, 0, headBuf.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new Error('Missing MP4 moov header');

  const moovKids = listBoxes(headBuf, moov.dataStart, moov.end);
  const mvhd = moovKids.find((b) => b.type === 'mvhd');
  if (!mvhd) throw new Error('Missing mvhd');

  let audioTrakBox = null;
  let mdhd = null;
  let stbl = null;
  let mdia = null;
  let minf = null;
  for (const b of moovKids) {
    if (b.type !== 'trak') continue;
    const tKids = listBoxes(headBuf, b.dataStart, b.end);
    const md = tKids.find((k) => k.type === 'mdia');
    if (!md) continue;
    const mKids = listBoxes(headBuf, md.dataStart, md.end);
    const hdlr = mKids.find((k) => k.type === 'hdlr');
    if (!hdlr || readFourCC(headBuf, hdlr.dataStart + 8) !== 'soun') continue;
    const mf = mKids.find((k) => k.type === 'minf');
    if (!mf) continue;
    const st = listBoxes(headBuf, mf.dataStart, mf.end).find((k) => k.type === 'stbl');
    if (!st) continue;
    audioTrakBox = b;
    mdia = md;
    minf = mf;
    stbl = st;
    mdhd = mKids.find((k) => k.type === 'mdhd');
    break;
  }
  if (!audioTrakBox || !stbl) throw new Error('No audio track found in MP4');

  // Audio sample rate & channel count from mdhd / stsd
  let sampleRate = 44100;
  let channels = 2;
  let codec = 'mp4a.40.2';
  let asc = null;
  const stblKids = listBoxes(headBuf, stbl.dataStart, stbl.end);
  const stsd = stblKids.find((b) => b.type === 'stsd');
  if (stsd && stsd.end - stsd.dataStart >= 44) {
    const entry = listBoxes(headBuf, stsd.dataStart + 8, stsd.end)[0];
    if (entry && entry.type === 'mp4a') {
      channels = dv.getUint16(entry.start + 24) || 2;
      sampleRate = (dv.getUint32(entry.start + 32) >>> 16) || 44100;
      const eSub = listBoxes(headBuf, entry.start + 36, entry.end);
      const esds = eSub.find((k) => k.type === 'esds');
      if (esds) {
        asc = parseEsdsConfig(headBuf, esds.dataStart, esds.end);
        if (asc && asc.length >= 2) {
          const objType = asc[0] >> 3;
          if (objType) codec = `mp4a.40.${objType}`;
        }
      }
    }
  }
  if (mdhd) {
    const ver = headBuf[mdhd.dataStart];
    const ts = readU32(dv, mdhd.dataStart + (ver === 1 ? 20 : 12));
    if (ts > 0 && !sampleRate) sampleRate = ts;
  }

  const stco = stblKids.find((b) => b.type === 'stco');
  const co64 = stblKids.find((b) => b.type === 'co64');
  const stsc = stblKids.find((b) => b.type === 'stsc');
  const stsz = stblKids.find((b) => b.type === 'stsz');
  if ((!stco && !co64) || !stsc || !stsz) throw new Error('Incomplete MP4 sample table');

  const offsets = [];
  if (stco) {
    const n = readU32(dv, stco.dataStart + 4);
    for (let i = 0; i < n; i++) offsets.push(readU32(dv, stco.dataStart + 8 + i * 4));
  } else {
    const n = readU32(dv, co64.dataStart + 4);
    for (let i = 0; i < n; i++) offsets.push(readU64(dv, co64.dataStart + 8 + i * 8));
  }

  const stscEntries = [];
  const nStsc = readU32(dv, stsc.dataStart + 4);
  for (let i = 0; i < nStsc; i++) {
    stscEntries.push({
      firstChunk: readU32(dv, stsc.dataStart + 8 + i * 12),
      samplesPerChunk: readU32(dv, stsc.dataStart + 12 + i * 12)
    });
  }

  const uniformSize = readU32(dv, stsz.dataStart + 4);
  const totalSamples = readU32(dv, stsz.dataStart + 8);
  const sampleSizes = new Uint32Array(totalSamples);
  if (uniformSize > 0) {
    sampleSizes.fill(uniformSize);
  } else {
    for (let i = 0; i < totalSamples; i++) sampleSizes[i] = readU32(dv, stsz.dataStart + 12 + i * 4);
  }

  const chunks = [];
  let sampleIdx = 0;
  let totalAudioBytes = 0;
  for (let ci = 0, run = 0; ci < offsets.length; ci++) {
    const chunkNum = ci + 1;
    while (run + 1 < stscEntries.length && chunkNum >= stscEntries[run + 1].firstChunk) run++;
    const count = stscEntries[run]?.samplesPerChunk || 0;
    const endSample = Math.min(totalSamples, sampleIdx + count);
    const sizes = sampleSizes.subarray(sampleIdx, endSample);
    let byteLength = 0;
    for (let k = 0; k < sizes.length; k++) byteLength += sizes[k];
    chunks.push({ offset: offsets[ci], byteLength, sampleStart: sampleIdx, sizes });
    totalAudioBytes += byteLength;
    sampleIdx = endSample;
  }

  // Sort chunks by file offset so streaming range reads can emit strictly in offset order
  // Wait: chunks in MP4 are already strictly ordered in file, preserve chunkOrder for stco rewrite!
  const sortedChunks = chunks.slice().sort((a, b) => a.offset - b.offset);

  return {
    moovEnd: moov.end,
    mvhdBytes: headBuf.slice(mvhd.start, mvhd.end),
    trakBytes: headBuf.slice(audioTrakBox.start, audioTrakBox.end),
    trakRel: {
      mdiaStart: mdia.start - audioTrakBox.start,
      mdiaEnd: mdia.end - audioTrakBox.start,
      minfStart: minf.start - audioTrakBox.start,
      minfEnd: minf.end - audioTrakBox.start,
      stblStart: stbl.start - audioTrakBox.start,
      stblEnd: stbl.end - audioTrakBox.start
    },
    chunks,
    sortedChunks,
    totalAudioBytes,
    sampleRate,
    channels,
    codec,
    audioSpecificConfig: asc
  };
}

export function buildM4aBlob(header, chunkPayloads) {
  const ftyp = makeM4aFtyp();
  const { trakBytes, trakRel, mvhdBytes, chunks } = header;

  const stblHdrSize = trakBytes[trakRel.stblStart] === 0 && readU32(new DataView(trakBytes.buffer, trakBytes.byteOffset + trakRel.stblStart, 4), 0) === 1 ? 16 : 8;
  const stblKids = listBoxes(trakBytes, trakRel.stblStart + stblHdrSize, trakRel.stblEnd);
  const keptStblParts = [];
  for (const k of stblKids) {
    if (k.type !== 'stco' && k.type !== 'co64') keptStblParts.push(trakBytes.subarray(k.start, k.end));
  }

  // Compute exact size of stco so we know newMoov byteLength in 1 pass
  const stcoSize = 16 + chunks.length * 4;
  const newStco = new Uint8Array(stcoSize);
  const stcoDv = new DataView(newStco.buffer);
  stcoDv.setUint32(0, stcoSize);
  newStco.set([0x73, 0x74, 0x63, 0x6f], 4); // stco
  stcoDv.setUint32(8, 0);
  stcoDv.setUint32(12, chunks.length);

  const newStbl = makeBox('stbl', ...keptStblParts, newStco);
  const stcoInStbl = newStbl.byteLength - stcoSize;

  const findOffset = (kids, targetType, replacement, dataBytes) => {
    let before = 8; // parent header
    let foundAt = -1;
    const parts = kids.map((k) => {
      if (k.type === targetType) {
        foundAt = before;
        before += replacement.byteLength;
        return replacement;
      }
      const slice = dataBytes.subarray(k.start, k.end);
      before += slice.byteLength;
      return slice;
    });
    return { parts, foundAt };
  };

  const minfHdrSize = readU32(new DataView(trakBytes.buffer, trakBytes.byteOffset + trakRel.minfStart, 4), 0) === 1 ? 16 : 8;
  const minfKids = listBoxes(trakBytes, trakRel.minfStart + minfHdrSize, trakRel.minfEnd);
  const minfRes = findOffset(minfKids, 'stbl', newStbl, trakBytes);
  const newMinf = makeBox('minf', ...minfRes.parts);

  const mdiaHdrSize = readU32(new DataView(trakBytes.buffer, trakBytes.byteOffset + trakRel.mdiaStart, 4), 0) === 1 ? 16 : 8;
  const mdiaKids = listBoxes(trakBytes, trakRel.mdiaStart + mdiaHdrSize, trakRel.mdiaEnd);
  const mdiaRes = findOffset(mdiaKids, 'minf', newMinf, trakBytes);
  const newMdia = makeBox('mdia', ...mdiaRes.parts);

  const trakHdrSize = readU32(new DataView(trakBytes.buffer, trakBytes.byteOffset, 4), 0) === 1 ? 16 : 8;
  const trakKids = listBoxes(trakBytes, trakHdrSize, trakBytes.length);
  const trakRes = findOffset(trakKids, 'mdia', newMdia, trakBytes);
  const newTrak = makeBox('trak', ...trakRes.parts);

  const newMoov = makeBox('moov', mvhdBytes, newTrak);
  const mdatPayloadStart = ftyp.byteLength + newMoov.byteLength + 8;
  const stcoOffInMoov = 8 + mvhdBytes.byteLength + trakRes.foundAt + mdiaRes.foundAt + minfRes.foundAt + stcoInStbl;
  const moovDv = new DataView(newMoov.buffer);
  let cursor = mdatPayloadStart;
  for (let i = 0; i < chunks.length; i++) {
    moovDv.setUint32(stcoOffInMoov + 16 + i * 4, cursor);
    cursor += chunks[i].byteLength;
  }

  const mdatHdr = new Uint8Array(8);
  const mdatDv = new DataView(mdatHdr.buffer);
  mdatDv.setUint32(0, 8 + header.totalAudioBytes);
  mdatHdr.set([0x6d, 0x64, 0x61, 0x74], 4); // mdat

  return new Blob([ftyp, newMoov, mdatHdr, ...chunkPayloads], { type: 'audio/mp4' });
}

async function fetchRangeSlice(url, start, end, totalSize) {
  const clampedEnd = totalSize ? Math.min(end, totalSize - 1) : end;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('Chunk download timed out')), 25_000);
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${clampedEnd}` }, signal: ac.signal });
      if (!res.ok && res.status !== 206) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.reason || `HTTP ${res.status}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('Chunk download failed');
}

function audioDataToInt16Planes(ad) {
  const nCh = Math.min(2, ad.numberOfChannels || 1);
  const nFrames = ad.numberOfFrames;
  const f32L = new Float32Array(nFrames);
  const f32R = nCh === 2 ? new Float32Array(nFrames) : null;

  try {
    ad.copyTo(f32L, { planeIndex: 0, format: 'f32-planar' });
    if (f32R) ad.copyTo(f32R, { planeIndex: 1, format: 'f32-planar' });
  } catch {
    const fmt = ad.format || 'f32';
    const isPlanar = fmt.endsWith('-planar');
    const base = isPlanar ? fmt.slice(0, -7) : fmt;
    const readSample = (arr, idx) => {
      if (base === 'f32') return arr[idx];
      if (base === 's16') return arr[idx] / 32768;
      if (base === 's32') return arr[idx] / 2147483648;
      return (arr[idx] - 128) / 128;
    };
    const mkArr = (len) => (base === 'f32' ? new Float32Array(len) : base === 's16' ? new Int16Array(len) : base === 's32' ? new Int32Array(len) : new Uint8Array(len));
    if (isPlanar) {
      const p0 = mkArr(nFrames);
      ad.copyTo(p0, { planeIndex: 0 });
      for (let i = 0; i < nFrames; i++) f32L[i] = readSample(p0, i);
      if (f32R) {
        const p1 = mkArr(nFrames);
        ad.copyTo(p1, { planeIndex: 1 });
        for (let i = 0; i < nFrames; i++) f32R[i] = readSample(p1, i);
      }
    } else {
      const chAll = ad.numberOfChannels || 1;
      const interleaved = mkArr(nFrames * chAll);
      ad.copyTo(interleaved, { planeIndex: 0 });
      for (let i = 0; i < nFrames; i++) {
        f32L[i] = readSample(interleaved, i * chAll);
        if (f32R) f32R[i] = readSample(interleaved, i * chAll + 1);
      }
    }
  }

  const toI16 = (f32) => {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const v = Math.max(-1, Math.min(1, f32[i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  };
  return { nCh, left: toI16(f32L), right: f32R ? toI16(f32R) : null };
}

export async function downloadMp4AsAudio({ streamUrl, totalSize, wantMp3, loadLame, onProgress }) {
  // 1. Fetch MP4 header (ftyp + moov; extends past 2 MB on 2h+ files)
  onProgress?.('Reading audio index…', 0);
  const firstSlice = await fetchRangeSlice(streamUrl, 0, HEAD_PROBE - 1, totalSize);
  const dv0 = new DataView(firstSlice.buffer, firstSlice.byteOffset, firstSlice.byteLength);
  let scanPos = 0;
  let moovEnd = 0;
  while (scanPos + 8 <= firstSlice.length) {
    let sz = readU32(dv0, scanPos);
    const type = readFourCC(firstSlice, scanPos + 4);
    if (sz === 1 && scanPos + 16 <= firstSlice.length) sz = readU64(dv0, scanPos + 8);
    if (type === 'moov') { moovEnd = scanPos + sz; break; }
    if (!sz || scanPos + sz > firstSlice.length) break;
    scanPos += sz;
  }
  if (!moovEnd) throw new Error('Could not locate MP4 audio index');

  let headBuf = firstSlice;
  while (headBuf.length < moovEnd) {
    const nextEnd = Math.min(moovEnd + 1024 * 1024 - 1, totalSize ? totalSize - 1 : moovEnd - 1);
    const extra = await fetchRangeSlice(streamUrl, headBuf.length, nextEnd, totalSize);
    const merged = new Uint8Array(headBuf.length + extra.length);
    merged.set(headBuf, 0);
    merged.set(extra, headBuf.length);
    headBuf = merged;
  }

  const header = parseMp4AudioHeader(headBuf.subarray(0, moovEnd));
  const { sortedChunks, totalAudioBytes, sampleRate, channels, codec, audioSpecificConfig } = header;
  if (!sortedChunks.length) throw new Error('No audio chunks in stream');

  // Decide streaming MP3 vs pure M4A
  let useMp3Decoder = false;
  let activeDesc = audioSpecificConfig;
  let lame = null;
  if (wantMp3 && typeof AudioDecoder !== 'undefined' && audioSpecificConfig) {
    for (const candidateDesc of (audioSpecificConfig.length > 2 ? [audioSpecificConfig, audioSpecificConfig.subarray(0, 2)] : [audioSpecificConfig])) {
      try {
        const sup = await AudioDecoder.isConfigSupported({
          codec,
          sampleRate,
          numberOfChannels: channels,
          description: candidateDesc
        });
        if (sup.supported) {
          activeDesc = candidateDesc;
          lame = await loadLame();
          useMp3Decoder = true;
          break;
        }
      } catch {}
    }
  }

  let mp3Enc = null;
  let decoder = null;
  let decodeErr = null;
  const mp3Parts = [];
  if (useMp3Decoder) {
    mp3Enc = new lame.Mp3Encoder(Math.min(2, channels), sampleRate, 128);
    decoder = new AudioDecoder({
      output(ad) {
        try {
          const { nCh, left, right } = audioDataToInt16Planes(ad);
          const buf = nCh === 2 ? mp3Enc.encodeBuffer(left, right) : mp3Enc.encodeBuffer(left);
          if (buf.length) mp3Parts.push(new Uint8Array(buf));
        } catch (e) {
          decodeErr = e;
        } finally {
          ad.close();
        }
      },
      error(e) {
        decodeErr = e;
      }
    });
    decoder.configure({
      codec,
      sampleRate,
      numberOfChannels: channels,
      description: activeDesc
    });
  }

  const keepM4aChunks = !useMp3Decoder;
  const mdatChunkData = new Array(sortedChunks.length);
  // Map chunk reference -> original index for M4A stco alignment
  const chunkOrigIndex = new Map();
  for (let i = 0; i < header.chunks.length; i++) chunkOrigIndex.set(header.chunks[i], i);

  // Build buffered reader cursor starting from any leftover tail inside headBuf
  const minOffset = sortedChunks[0].offset;
  const maxOffset = sortedChunks[sortedChunks.length - 1].offset + sortedChunks[sortedChunks.length - 1].byteLength;

  // Schedule 2-wide parallel 8 MB fetches covering [max(minOffset, headBuf.length) .. maxOffset)
  const fetchStart = Math.max(minOffset, headBuf.length);
  const ranges = [];
  for (let s = fetchStart; s < maxOffset; s += RANGE_CHUNK) {
    ranges.push([s, Math.min(maxOffset - 1, s + RANGE_CHUNK - 1)]);
  }

  // Sliding window of at most 2 concurrent fetches processed strictly in order
  const pending = [];
  let rIdx = 0;
  const enqueueFetch = () => {
    while (pending.length < 2 && rIdx < ranges.length) {
      const [s, e] = ranges[rIdx++];
      pending.push({ start: s, end: e, promise: fetchRangeSlice(streamUrl, s, e, totalSize) });
    }
  };
  enqueueFetch();

  let curOffset = headBuf.length;
  let curBuf = headBuf;
  let chunkPtr = 0;
  let partialChunk = null;
  let partialFilled = 0;
  let audioBytesDone = 0;
  let sampleCounter = 0;
  let lastProgressAt = 0;

  const emitChunk = async (chunk, bytes) => {
    const idx = chunkOrigIndex.get(chunk);
    if (keepM4aChunks) mdatChunkData[idx] = bytes;
    if (useMp3Decoder) {
      if (decodeErr) throw decodeErr;
      let off = 0;
      for (let i = 0; i < chunk.sizes.length; i++) {
        const sLen = chunk.sizes[i];
        const tsUs = Math.round((sampleCounter * 1024 * 1_000_000) / sampleRate);
        decoder.decode(new EncodedAudioChunk({
          type: 'key',
          timestamp: tsUs,
          duration: Math.round((1024 * 1_000_000) / sampleRate),
          data: bytes.subarray(off, off + sLen)
        }));
        off += sLen;
        sampleCounter++;
      }
      if (decoder.decodeQueueSize > 48) {
        await decoder.flush();
      }
    }
    audioBytesDone += bytes.byteLength;
    const now = performance.now();
    if (now - lastProgressAt > 250) {
      lastProgressAt = now;
      const pct = Math.min(99, Math.round((audioBytesDone / totalAudioBytes) * 100));
      onProgress?.(useMp3Decoder ? `Downloading & encoding MP3… ${pct}%` : `Downloading M4A… ${pct}%`, pct);
    }
  };

  // Feed buffer slice [bufStart .. bufStart + buf.length) into ordered sortedChunks
  const consumeWindow = async (bufStart, buf) => {
    const bufEnd = bufStart + buf.length;
    while (chunkPtr < sortedChunks.length) {
      const chunk = sortedChunks[chunkPtr];
      if (!partialChunk && chunk.offset >= bufEnd) break;

      if (!partialChunk) {
        if (chunk.offset < bufStart) {
          throw new Error('Range gap encountered during audio extraction');
        }
        const localStart = chunk.offset - bufStart;
        const avail = buf.length - localStart;
        if (avail >= chunk.byteLength) {
          await emitChunk(chunk, buf.slice(localStart, localStart + chunk.byteLength));
          chunkPtr++;
          continue;
        }
        partialChunk = new Uint8Array(chunk.byteLength);
        partialChunk.set(buf.subarray(localStart), 0);
        partialFilled = avail;
        break;
      } else {
        const need = partialChunk.length - partialFilled;
        const take = Math.min(need, buf.length);
        partialChunk.set(buf.subarray(0, take), partialFilled);
        partialFilled += take;
        if (partialFilled < partialChunk.length) break;
        const doneBuf = partialChunk;
        partialChunk = null;
        partialFilled = 0;
        await emitChunk(chunk, doneBuf);
        chunkPtr++;
        // Advance local pointer inside buf if remaining bytes hold more chunks
        if (chunkPtr < sortedChunks.length) {
          const nextChunk = sortedChunks[chunkPtr];
          if (nextChunk.offset < bufStart) throw new Error('Chunk offset regression');
        }
      }
    }
  };

  // Handle chunks starting inside initial headBuf (after moovEnd) cleanly
  if (headBuf.length > minOffset) {
    await consumeWindow(0, curBuf);
  }

  while (pending.length) {
    const item = pending.shift();
    enqueueFetch();
    const slice = await item.promise;
    curOffset = item.start;
    curBuf = slice;
    await consumeWindow(curOffset, curBuf);
  }

  if (chunkPtr !== sortedChunks.length) {
    throw new Error(`Incomplete audio extraction (${chunkPtr}/${sortedChunks.length} chunks)`);
  }

  if (useMp3Decoder) {
    onProgress?.('Finalizing MP3…', 99);
    await decoder.flush();
    decoder.close();
    if (decodeErr) throw decodeErr;
    const tail = mp3Enc.flush();
    if (tail.length) mp3Parts.push(new Uint8Array(tail));
    return {
      ext: 'mp3',
      converted: true,
      blob: new Blob(mp3Parts, { type: 'audio/mpeg' })
    };
  }

  onProgress?.('Building M4A file…', 99);
  const m4aBlob = buildM4aBlob(header, mdatChunkData);
  return {
    ext: 'm4a',
    converted: false,
    blob: m4aBlob
  };
}

export async function downloadRangeBlob({ streamUrl, totalSize = 0, mime = 'audio/mp4', onProgress }) {
  if (!totalSize) {
    const hc = new AbortController();
    const ht = setTimeout(() => hc.abort(), 6_000);
    try {
      const hr = await fetch(streamUrl, { method: 'HEAD', signal: hc.signal });
      const hLen = Number(hr.headers.get('content-length') || 0);
      const ar = (hr.headers.get('accept-ranges') || '').toLowerCase();
      if (hr.ok && hLen > RANGE_CHUNK * 1.5 && ar.includes('bytes')) totalSize = hLen;
    } catch {} finally {
      clearTimeout(ht);
    }
  }
  if (totalSize > 0) {
    const parts = [];
    const ranges = [];
    for (let s = 0; s < totalSize; s += RANGE_CHUNK) {
      ranges.push([s, Math.min(totalSize - 1, s + RANGE_CHUNK - 1)]);
    }
    let doneBytes = 0;
    const inflight = [];
    let idx = 0;
    const enqueue = () => {
      while (inflight.length < 2 && idx < ranges.length) {
        const [s, e] = ranges[idx++];
        inflight.push({ s, e, promise: fetchRangeSlice(streamUrl, s, e, totalSize) });
      }
    };
    enqueue();
    while (inflight.length) {
      const item = inflight.shift();
      enqueue();
      const slice = await item.promise;
      parts.push(slice);
      doneBytes += slice.byteLength;
      const pct = Math.min(99, Math.round((doneBytes / totalSize) * 100));
      onProgress?.(`Downloading audio… ${pct}%`, pct);
    }
    return new Blob(parts, { type: mime });
  }

  onProgress?.('Downloading audio…', 0);
  const ac = new AbortController();
  let stallTimer = setTimeout(() => ac.abort(new Error('Audio download stalled')), 25_000);
  const bumpStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ac.abort(new Error('Audio download stalled')), 25_000);
  };
  try {
    const res = await fetch(streamUrl, { signal: ac.signal });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.reason || `HTTP ${res.status}`);
    }
    bumpStall();
    const len = Number(res.headers.get('content-length') || 0);
    if (!res.body || !res.body.getReader) {
      const buf = await res.arrayBuffer();
      onProgress?.('Downloading audio… 100%', 100);
      return new Blob([buf], { type: res.headers.get('content-type') || mime });
    }
    const reader = res.body.getReader();
    const parts = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bumpStall();
      if (value && value.byteLength) {
        parts.push(value);
        loaded += value.byteLength;
        const pct = len > 0 ? Math.min(99, Math.round((loaded / len) * 100)) : 0;
        const mb = (loaded / (1024 * 1024)).toFixed(1);
        onProgress?.(len > 0 ? `Downloading audio… ${pct}%` : `Downloading audio… ${mb} MB`, pct);
      }
    }
    return new Blob(parts, { type: res.headers.get('content-type') || mime });
  } finally {
    clearTimeout(stallTimer);
  }
}
