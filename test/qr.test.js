import test from 'node:test';
import assert from 'node:assert/strict';
import { generateQRCodeSVG } from '../public/js/qr.js';

test('generateQRCodeSVG returns valid SVG structure', () => {
  const url = 'https://syncpad.muamer-arifi.workers.dev?room=NOTE-1234';
  const svg = generateQRCodeSVG(url, 200);

  assert.ok(typeof svg === 'string', 'SVG must be a string');
  assert.ok(svg.startsWith('<svg'), 'SVG must start with <svg');
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'SVG must include xml namespace');
  assert.ok(svg.includes('viewBox="0 0 200 200"'), 'SVG must have viewBox matching size');
  assert.ok(svg.includes('<rect'), 'SVG must have rect modules');
  assert.ok(svg.endsWith('</svg>'), 'SVG must end with </svg>');
});

test('generateQRCodeSVG handles different sizes and room URLs', () => {
  const shortRoom = 'https://syncpad.workers.dev?room=A';
  const longRoom = 'https://syncpad.muamer-arifi.workers.dev?room=LONG-ROOM-CODE-987654321-TEST';

  const svgShort = generateQRCodeSVG(shortRoom, 160);
  const svgLong = generateQRCodeSVG(longRoom, 240);

  assert.ok(svgShort.includes('width="160"'), 'Short room SVG must have width 160');
  assert.ok(svgLong.includes('width="240"'), 'Long room SVG must have width 240');
  assert.ok(svgShort.includes('<rect'), 'Must contain rects');
  assert.ok(svgLong.includes('<rect'), 'Must contain rects');
});

test('generateQRCodeSVG handles empty or fallback input safely', () => {
  const svg = generateQRCodeSVG('', 180);
  assert.ok(svg.startsWith('<svg'), 'Empty input must still return valid SVG');
  assert.ok(svg.includes('width="180"'), 'Width must be 180');
});
