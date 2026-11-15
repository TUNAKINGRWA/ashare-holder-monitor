/**
 * 浏览器与服务端通用的零依赖 ISO/IEC 18004 二维码 SVG 生成器
 */

const VERSION_SPECS_L = [
  null,
  { size: 21, totalData: 19, ecPerBlock: 7, blocks: 1, align: [] },
  { size: 25, totalData: 34, ecPerBlock: 10, blocks: 1, align: [6, 18] },
  { size: 29, totalData: 55, ecPerBlock: 15, blocks: 1, align: [6, 22] },
  { size: 33, totalData: 80, ecPerBlock: 20, blocks: 1, align: [6, 26] },
  { size: 37, totalData: 108, ecPerBlock: 26, blocks: 1, align: [6, 30] },
  { size: 41, totalData: 136, ecPerBlock: 18, blocks: 2, align: [6, 34] },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function buildRsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function computeRsRemainder(dataBytes, ecLen) {
  const gen = buildRsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (const byte of dataBytes) {
    const lead = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    for (let j = 0; j < ecLen; j++) rem[j] ^= gfMul(gen[j + 1], lead);
  }
  return rem;
}

function computeFormatBits(eccBits, mask) {
  const data = (eccBits << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function encodeCodewords(text) {
  const utf8 = new TextEncoder().encode(String(text));
  let ver = 1;
  while (ver <= 6 && utf8.length + 2 > VERSION_SPECS_L[ver].totalData) ver++;
  if (ver > 6) throw new Error('QR payload exceeds 134 bytes');

  const spec = VERSION_SPECS_L[ver];
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  pushBits(0b0100, 4);
  pushBits(utf8.length, 8);
  for (const b of utf8) pushBits(b, 8);

  const maxBits = spec.totalData * 8;
  pushBits(0, Math.min(4, maxBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = new Uint8Array(spec.totalData);
  for (let i = 0; i < bits.length / 8; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    dataBytes[i] = v;
  }
  const pads = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < spec.totalData; i++, p++) dataBytes[i] = pads[p % 2];

  if (spec.blocks === 1) {
    const ec = computeRsRemainder(dataBytes, spec.ecPerBlock);
    const all = new Uint8Array(dataBytes.length + ec.length);
    all.set(dataBytes, 0);
    all.set(ec, dataBytes.length);
    return { ver, spec, codewords: all };
  }

  const blockLen = spec.totalData / 2;
  const d1 = dataBytes.subarray(0, blockLen);
  const d2 = dataBytes.subarray(blockLen);
  const e1 = computeRsRemainder(d1, spec.ecPerBlock);
  const e2 = computeRsRemainder(d2, spec.ecPerBlock);
  const all = new Uint8Array(spec.totalData + spec.ecPerBlock * 2);
  let ptr = 0;
  for (let i = 0; i < blockLen; i++) {
    all[ptr++] = d1[i];
    all[ptr++] = d2[i];
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    all[ptr++] = e1[i];
    all[ptr++] = e2[i];
  }
  return { ver, spec, codewords: all };
}

function buildMatrixForMask(spec, codewords, maskId) {
  const n = spec.size;
  const modules = Array.from({ length: n }, () => new Uint8Array(n));
  const reserved = Array.from({ length: n }, () => new Uint8Array(n));

  const setFunc = (r, c, dark) => {
    if (r < 0 || r >= n || c < 0 || c >= n) return;
    modules[r][c] = dark ? 1 : 0;
    reserved[r][c] = 1;
  };

  const placeFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunc(top + dr, left + dc, inOuter && (onBorder || inCenter));
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, n - 7);
  placeFinder(n - 7, 0);

  if (spec.align.length >= 2) {
    for (const ar of spec.align) {
      for (const ac of spec.align) {
        if ((ar === 6 && ac === 6) || (ar === 6 && ac === n - 7) || (ar === n - 7 && ac === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            setFunc(ar + dr, ac + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
          }
        }
      }
    }
  }

  for (let i = 8; i < n - 8; i++) {
    if (!reserved[6][i]) setFunc(6, i, i % 2 === 0);
    if (!reserved[i][6]) setFunc(i, 6, i % 2 === 0);
  }

  setFunc(n - 8, 8, true);
  for (let i = 0; i <= 8; i++) {
    if (!reserved[8][i]) reserved[8][i] = 1;
    if (!reserved[i][8]) reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][n - 1 - i] = 1;
    reserved[n - 1 - i][8] = 1;
  }

  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      const r = upward ? n - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (reserved[r][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        const invert = (r + c) % 2 === 0;
        modules[r][c] = invert ? bit ^ 1 : bit;
      }
    }
    upward = !upward;
  }

  const fmt = computeFormatBits(0b01, maskId);
  for (let i = 0; i <= 5; i++) modules[i][8] = (fmt >> i) & 1;
  modules[7][8] = (fmt >> 6) & 1;
  modules[8][8] = (fmt >> 7) & 1;
  modules[8][7] = (fmt >> 8) & 1;
  for (let i = 9; i < 15; i++) modules[8][14 - i] = (fmt >> i) & 1;

  for (let i = 0; i < 8; i++) modules[8][n - 1 - i] = (fmt >> i) & 1;
  for (let i = 8; i < 15; i++) modules[n - 15 + i][8] = (fmt >> i) & 1;

  return modules;
}

export function renderQrSvg(text, { margin = 3, darkColor = '#0f172a', lightColor = '#ffffff' } = {}) {
  const { spec, codewords } = encodeCodewords(text);
  const modules = buildMatrixForMask(spec, codewords, 0);
  const n = spec.size;
  const viewSize = n + margin * 2;
  let pathD = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (modules[r][c]) pathD += `M${c + margin},${r + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges"><rect width="${viewSize}" height="${viewSize}" rx="2" fill="${lightColor}"/><path d="${pathD}" fill="${darkColor}"/></svg>`;
}
