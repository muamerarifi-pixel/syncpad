// Backup: one .zip with every note as a text file and every file in its folder.
// The zip is written by hand (no compression, "stored"), so it needs no library
// and opens on any computer or phone.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

async function crcOfBlob(blob) {
  let crc = 0;
  const step = 8 * 1024 * 1024;
  for (let at = 0; at < blob.size; at += step) {
    crc = crc32(new Uint8Array(await blob.slice(at, at + step).arrayBuffer()), crc);
  }
  return crc;
}

const enc = new TextEncoder();

function dosTime(ts) {
  const d = new Date(ts || Date.now());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; this.count = 0; }

  async add(path, data, ts) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const name = enc.encode(path);
    const crc = await crcOfBlob(blob);
    const size = blob.size;
    const { time, date } = dosTime(ts);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(8, 0, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, name.length, true); c.setUint32(42, this.offset, true);
    this.parts.push(h.buffer, name, blob);
    this.central.push(c.buffer, name);
    this.offset += 30 + name.length + size;
    this.count++;
  }

  finish() {
    const cdSize = this.central.reduce((s, p) => s + (p.byteLength != null ? p.byteLength : p.length), 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, this.count, true); e.setUint16(10, this.count, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, e.buffer], { type: 'application/zip' });
  }
}

/** Safe, unique file and folder names. */
export function namer() {
  const used = new Set();
  const clean = (s, fallback) => (String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80) || fallback);
  return (dir, base, ext, fallback = 'Untitled') => {
    const b = clean(base, fallback);
    let p = `${dir}${b}${ext}`;
    for (let i = 2; used.has(p.toLowerCase()); i++) p = `${dir}${b} (${i})${ext}`;
    used.add(p.toLowerCase());
    return p;
  };
}
export const cleanName = (s, fb) => namer()('', s, '', fb);
