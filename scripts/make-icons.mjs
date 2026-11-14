// Gera os ícones PNG do PWA usando apenas módulos nativos do Node.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  // área segura: ícone "maskable" usa ~60% do lado; o normal usa cantos arredondados
  const scale = maskable ? 0.6 : 0.78;
  const R = (size / 2) * scale;
  const corner = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      // fundo: gradiente diagonal escuro
      const t = (x + y) / (2 * size);
      let r = 15 + 25 * t, g = 17 + 12 * t, b = 21 + 45 * t, a = 255;
      if (!maskable) {
        // cantos arredondados transparentes
        const dx = Math.max(corner - x, x - (size - 1 - corner), 0);
        const dy = Math.max(corner - y, y - (size - 1 - corner), 0);
        if (dx * dx + dy * dy > corner * corner) a = 0;
      }
      // disco com gradiente (paleta de tinta)
      const d = Math.hypot(x - cx, y - cy);
      if (d < R) {
        const u = (x - (cx - R)) / (2 * R), v = (y - (cy - R)) / (2 * R);
        r = 139 + (106 - 139) * v; g = 124 + (90 - 124) * v; b = 255 + (240 - 255) * v;
        r += 40 * (1 - u) * (1 - v); g += 40 * (1 - u) * (1 - v); b += 0;
        // brilho "estrela" interna
        const sx = Math.abs(x - cx) / R, sy = Math.abs(y - cy) / R;
        if (Math.pow(sx, 0.6) + Math.pow(sy, 0.6) < 0.55) { r = 255; g = 255; b = 255; }
      } else if (d < R + size * 0.012) {
        const f = 1 - (d - R) / (size * 0.012);
        r += (139 - r) * f * 0.5; g += (124 - g) * f * 0.5; b += (255 - b) * f * 0.5;
      }
      px[o] = Math.min(255, r); px[o + 1] = Math.min(255, g); px[o + 2] = Math.min(255, b); px[o + 3] = a;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192, false));
writeFileSync('public/icons/icon-512.png', png(512, false));
writeFileSync('public/icons/maskable-512.png', png(512, true));
console.log('Ícones gerados em public/icons');
