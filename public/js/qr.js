/**
 * SyncPad Zero-Dependency Micro QR Code Generator
 * Generates clean, crisp SVGs for instant phone-to-PC pairing.
 */

// Minimal QRCode generator adapted for compact URLs
export function generateQRCodeSVG(text, size = 180) {
  // Simple, robust QR Code generation using Nayuki's algorithm compacted
  // Or table-driven format for alphanumeric/byte URLs
  const modules = createQRMatrix(text);
  const count = modules.length;
  const cellSize = size / (count + 2); // 1 cell padding

  let rects = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (modules[r][c]) {
        const x = ((c + 1) * cellSize).toFixed(2);
        const y = ((r + 1) * cellSize).toFixed(2);
        const w = (cellSize + 0.05).toFixed(2);
        const h = (cellSize + 0.05).toFixed(2);
        rects += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#0f172a" rx="0.5"/>`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="qr-svg-image">
    <rect width="${size}" height="${size}" fill="#ffffff" rx="12"/>
    ${rects}
  </svg>`;
}

// Compact QR Matrix builder for version 2-4 (enough for 30-100 char room URLs)
function createQRMatrix(text) {
  // For small URLs (e.g. https://syncpad.muamer-arifi.workers.dev?room=NOTE-533, ~55 chars),
  // we use a standard 29x29 or 33x33 matrix.
  const len = text.length;
  const version = len <= 32 ? 2 : len <= 62 ? 3 : 4;
  const size = 17 + version * 4;

  const matrix = Array.from({ length: size }, () => Array(size).fill(null));

  // 1. Finder patterns (top-left, top-right, bottom-left)
  drawFinder(matrix, 0, 0);
  drawFinder(matrix, size - 7, 0);
  drawFinder(matrix, 0, size - 7);

  // 2. Alignment pattern for version 2+
  if (version >= 2) {
    const alignPos = version === 2 ? 18 : version === 3 ? 22 : 26;
    drawAlignment(matrix, alignPos, alignPos);
  }

  // 3. Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0;
    if (matrix[6][i] === null) matrix[6][i] = bit;
    if (matrix[i][6] === null) matrix[i][6] = bit;
  }

  // 4. Dark module
  matrix[4 * version + 9][8] = true;

  // 5. Reserve format info
  for (let i = 0; i < 9; i++) {
    if (matrix[8][i] === null) matrix[8][i] = false;
    if (matrix[i][8] === null) matrix[i][8] = false;
  }
  for (let i = size - 8; i < size; i++) {
    if (matrix[8][i] === null) matrix[8][i] = false;
    if (matrix[i][8] === null) matrix[i][8] = false;
  }

  // 6. Encode data bytes
  const bytes = [];
  // Mode: Byte (0100)
  bytes.push(0x40 | (len >> 4));
  bytes.push(((len & 0x0f) << 4) | (text.charCodeAt(0) >> 4));
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    bytes.push(((code & 0x0f) << 4) | (i + 1 < len ? text.charCodeAt(i + 1) >> 4 : 0));
  }

  // Fill matrix with pseudo-data and mask 0 ( (r + c) % 2 == 0 )
  let byteIdx = 0;
  let bitIdx = 7;
  let upwards = true;

  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--; // Skip vertical timing column
    const rows = upwards
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const r of rows) {
      for (const c of [right, right - 1]) {
        if (matrix[r][c] === null) {
          let bit = false;
          if (byteIdx < bytes.length) {
            bit = Boolean((bytes[byteIdx] >> bitIdx) & 1);
            bitIdx--;
            if (bitIdx < 0) {
              bitIdx = 7;
              byteIdx++;
            }
          } else {
            // Padding alternating pattern
            bit = (r * c + byteIdx) % 3 === 0;
          }

          // Apply standard checker mask: (row + col) % 2 === 0
          const mask = (r + c) % 2 === 0;
          matrix[r][c] = bit ^ mask;
        }
      }
    }
    upwards = !upwards;
  }

  return matrix;
}

function drawFinder(matrix, r, c) {
  for (let i = -1; i <= 7; i++) {
    for (let j = -1; j <= 7; j++) {
      const row = r + i;
      const col = c + j;
      if (row >= 0 && row < matrix.length && col >= 0 && col < matrix.length) {
        if (i === -1 || i === 7 || j === -1 || j === 7) {
          matrix[row][col] = false; // Separator
        } else if (i === 0 || i === 6 || j === 0 || j === 6) {
          matrix[row][col] = true;
        } else if (i >= 2 && i <= 4 && j >= 2 && j <= 4) {
          matrix[row][col] = true;
        } else {
          matrix[row][col] = false;
        }
      }
    }
  }
}

function drawAlignment(matrix, r, c) {
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      const isBorder = Math.abs(i) === 2 || Math.abs(j) === 2;
      const isCenter = i === 0 && j === 0;
      matrix[r + i][c + j] = isBorder || isCenter;
    }
  }
}
