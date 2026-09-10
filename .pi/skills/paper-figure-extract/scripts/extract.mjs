#!/usr/bin/env node
/**
 * Extract every figure and table from a paper PDF as a tightly-cropped PNG.
 *
 * Usage:
 *   node extract.mjs <paper.pdf> [--out DIR] [--scale N] [--name SHORT] [--info] [--debug]
 *
 * Output files are named Figure_<n>.png and Table_<n>.png using the number
 * printed in the caption (Figure 1 -> Figure_1.png). The caption is included.
 *
 * Requires: mupdf, pngjs  (run `npm install` in the skill directory first).
 */
import fs from 'fs';
import path from 'path';
import * as mupdf from 'mupdf';
import { PNG } from 'pngjs';

/* ----------------------------- tunable params ----------------------------- */
const DEF_SCALE = 4.0;        // render scale (4 = 288 dpi)
const PAD_PT = 1.5;           // padding added around trimmed content (points)
const WHITE = 250;            // channel value >= this is treated as background
const CAP_GAP_PT = 40;        // max gap between caption and its graphic (points)
const INNER_GAP_PT = 15;      // max gap inside a figure/table graphic (points)
const TEXT_MASK_PAD_PT = 1;   // expand text block boxes before masking
const GROW_TEXT_PT = 30;      // how far labels may sit beyond the graphic box
const RULE_LOOKAHEAD_PT = 8;  // how far below a table to look for its bottom rule
const MIN_ROW_INK = 6;        // ignore thin page rules in the graphic profile

/* ------------------------------- arg parsing ------------------------------ */
function parseArgs(argv) {
  const args = { pdf: null, out: null, scale: DEF_SCALE, name: null, info: false, debug: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--scale') args.scale = parseFloat(argv[++i]);
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--info') args.info = true;
    else if (a === '--debug') args.debug = true;
    else rest.push(a);
  }
  args.pdf = rest[0];
  return args;
}

/* --------------------------------- helpers -------------------------------- */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function sanitizeName(s) {
  return (s || '')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '')
    .slice(0, 40);
}

function suggestShortName(title, fallback) {
  let base = (title || '').split(/[:：]/)[0].trim();
  // strip common prefixes like "Towards ...", keep it short
  if (!base || base.split(/\s+/).length > 5) {
    base = (title || '').split(/\s+/).slice(0, 3).join(' ');
  }
  const name = sanitizeName(base) || sanitizeName(fallback) || 'paper';
  return name;
}

function loadDoc(pdfPath) {
  const data = fs.readFileSync(pdfPath);
  return mupdf.Document.openDocument(data, 'application/pdf');
}

function pageTextBlocks(page) {
  const st = page.toStructuredText();
  const blocks = [];
  let cur = null, line = null;
  st.walk({
    beginTextBlock: (bbox) => { cur = { bbox: [...bbox], text: '', lines: [] }; },
    beginLine: (bbox) => { line = [...bbox]; },
    onChar: (c) => { if (cur) cur.text += c; },
    endLine: () => { if (cur && line) { cur.lines.push(line); line = null; } },
    endTextBlock: () => { if (cur) blocks.push(cur); cur = null; }
  });
  return blocks;
}

/* --------------------------- caption extraction --------------------------- */
// require punctuation right after the number ("Figure 1:" / "Fig. 1." /
// "Table 2:") so in-text references such as "Figure 12 shows ..." are skipped.
const CAPTION_RE = /^\s*(figure|fig\.?|table)\s+([0-9]{1,3}|[IVXLC]{1,6})\s*[:.]/i;

function toArabic(s) {
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  const roman = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let n = 0;
  const t = s.toLowerCase();
  for (let i = 0; i < t.length; i++) {
    const v = roman[t[i]] || 0, nx = roman[t[i + 1]] || 0;
    n += v < nx ? -v : v;
  }
  return n || null;
}

function collectCaptions(doc) {
  const nPages = doc.countPages();
  const pages = [];          // pages[i] = { blocks, captions }
  const captions = [];       // flat list
  for (let p = 0; p < nPages; p++) {
    const page = doc.loadPage(p);
    const blocks = pageTextBlocks(page);
    const caps = [];
    for (const b of blocks) {
      const m = b.text.match(CAPTION_RE);
      if (!m) continue;
      const label = m[1].toLowerCase().startsWith('tab') ? 'table' : 'figure';
      const num = toArabic(m[2]);
      if (!num) continue;
      const cap = { page: p, type: label, num, bbox: b.bbox, text: b.text.replace(/\s+/g, ' ').trim() };
      caps.push(cap);
      captions.push(cap);
    }
    pages.push({ blocks, captions: caps });
  }
  return { nPages, pages, captions };
}

/* --------------------------- column detection ----------------------------- */
function detectColumns(pages, pageWidth) {
  // A column gutter is an x-range that is empty on *most* pages. Counting
  // per-page emptiness is robust to the few full-width captions/tables.
  const W = Math.max(1, Math.ceil(pageWidth));
  const emptyCount = new Int32Array(W + 2);
  let left = Infinity, right = -Infinity;
  for (const pg of pages) {
    const cov = new Uint8Array(W + 2);
    for (const b of pg.blocks) {
      const [x0, , x1] = b.bbox;
      if (x1 - x0 < 4) continue;
      left = Math.min(left, x0);
      right = Math.max(right, x1);
      const a = clamp(Math.floor(x0), 0, W), z = clamp(Math.ceil(x1), 0, W);
      for (let x = a; x <= z; x++) cov[x] = 1;
    }
    for (let x = 0; x <= W; x++) if (!cov[x]) emptyCount[x]++;
  }
  if (!isFinite(left)) return { leftMargin: 0, rightMargin: pageWidth, twoCol: false };

  const nPages = pages.length;
  const thresh = Math.max(1, Math.round(nPages * 0.5));
  const lo = clamp(Math.floor(left) + 35, 0, W);
  const hi = clamp(Math.ceil(right) - 35, 0, W);
  let best = null, runStart = null;
  for (let x = lo; x <= hi; x++) {
    const empty = emptyCount[x] >= thresh;
    if (empty && runStart === null) runStart = x;
    if ((!empty || x === hi) && runStart !== null) {
      const end = empty && x === hi ? x : x - 1;
      if (end - runStart >= 8 && (!best || end - runStart > best.end - best.start)) {
        best = { start: runStart, end };
      }
      runStart = null;
    }
  }
  if (best) {
    const textW = right - left;
    const c = (best.start + best.end) / 2;
    // gutter must sit roughly in the middle of the text block
    if (c > left + textW * 0.3 && c < left + textW * 0.7) {
      return { leftMargin: left, rightMargin: right, twoCol: true, gutterStart: best.start, gutterEnd: best.end };
    }
  }
  return { leftMargin: left, rightMargin: right, twoCol: false };
}

function spanForCaption(cap, cols) {
  if (!cols.twoCol) return [cols.leftMargin, cols.rightMargin];
  const [x0, , x1] = cap.bbox;
  const spansGutter = x0 <= cols.gutterStart - 3 && x1 >= cols.gutterEnd + 3;
  if (spansGutter) return [cols.leftMargin, cols.rightMargin];
  const center = (x0 + x1) / 2;
  const mid = (cols.gutterStart + cols.gutterEnd) / 2;
  return center < mid ? [cols.leftMargin, cols.gutterStart] : [cols.gutterEnd, cols.rightMargin];
}

/* ------------------------------ pixel helpers ----------------------------- */
function isInk(px, idx) {
  const a = px[idx + 3];
  if (a === 0) return false;
  return px[idx] < WHITE || px[idx + 1] < WHITE || px[idx + 2] < WHITE;
}

function buildTextMask(pageBlocks, S, width, height, padPt) {
  const mask = new Uint8Array(width * height);
  const pad = padPt * S;
  for (const b of pageBlocks) {
    let x0 = clamp(Math.floor(b.bbox[0] * S - pad), 0, width - 1);
    let y0 = clamp(Math.floor(b.bbox[1] * S - pad), 0, height - 1);
    let x1 = clamp(Math.ceil(b.bbox[2] * S + pad), 0, width - 1);
    let y1 = clamp(Math.ceil(b.bbox[3] * S + pad), 0, height - 1);
    for (let y = y0; y <= y1; y++) {
      const row = y * width;
      mask.fill(1, row + x0, row + x1 + 1);
    }
  }
  return mask;
}

// rows that contain graphic ink (ink that is not inside a text block) in span
function graphicRowProfile(png, mask, S, span) {
  const x0 = clamp(Math.floor(span[0] * S), 0, png.width - 1);
  const x1 = clamp(Math.ceil(span[1] * S), 0, png.width - 1);
  const rows = new Int32Array(png.height);
  for (let y = 0; y < png.height; y++) {
    const base = y * png.width;
    let c = 0;
    for (let x = x0; x <= x1; x++) {
      const idx = (base + x) * 4;
      if (!mask[base + x] && isInk(png.data, idx)) c++;
    }
    rows[y] = c;
  }
  return rows;
}

// a "body paragraph" is a multi-line block whose lines all reach the right
// margin, unlike a table body (ragged columns) or a figure label.
function isBodyParagraph(block, span) {
  const w = block.bbox[2] - block.bbox[0];
  const h = block.bbox[3] - block.bbox[1];
  const len = block.text.replace(/\s+/g, '').length;
  const lines = block.lines || [];
  if (lines.length < 3 || h < 22 || len < 140) return false;
  const widths = lines.map(l => l[2] - l[0]).sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)];
  return median >= w * 0.9;
}

// union of text blocks above `capTop` that belong to a figure (fallback)
function textGroupAbove(blocks, capTop, span, maxGapPt) {
  const cand = blocks
    .filter(b => b.bbox[3] <= capTop + 1 && b.bbox[2] >= span[0] - 2 && b.bbox[0] <= span[1] + 2)
    .sort((a, b) => b.bbox[3] - a.bbox[3]);
  let top = capTop, prev = capTop;
  for (const b of cand) {
    if (prev - b.bbox[3] > maxGapPt) break;
    if (isBodyParagraph(b, span)) break;
    top = Math.min(top, b.bbox[1]);
    prev = b.bbox[1];
  }
  return top;
}

function textGroupBelow(blocks, capBot, span, maxGapPt) {
  const cand = blocks
    .filter(b => b.bbox[1] >= capBot - 1 && b.bbox[2] >= span[0] - 2 && b.bbox[0] <= span[1] + 2)
    .sort((a, b) => a.bbox[1] - b.bbox[1]);
  let bot = capBot, prev = capBot;
  for (const b of cand) {
    if (b.bbox[1] - prev > maxGapPt) break;
    if (isBodyParagraph(b, span)) break;
    bot = Math.max(bot, b.bbox[3]);
    prev = b.bbox[3];
  }
  return bot;
}

// trim a rectangular region to the bounding box of all ink (text + graphic)
function trimRegion(png, region) {
  const x0 = clamp(Math.floor(region[0]), 0, png.width - 1);
  const y0 = clamp(Math.floor(region[1]), 0, png.height - 1);
  const x1 = clamp(Math.ceil(region[2]), 0, png.width - 1);
  const y1 = clamp(Math.ceil(region[3]), 0, png.height - 1);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = y0; y <= y1; y++) {
    const base = y * png.width;
    for (let x = x0; x <= x1; x++) {
      const idx = (base + x) * 4;
      if (isInk(png.data, idx)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX === Infinity) return null;
  return [minX, minY, maxX, maxY];
}

/* ------------------------- graphic vertical extent ------------------------ */
// Walk from `fromRow` in `dir` until a graphic run is found and closed.
function graphicRun(rows, fromRow, dir, S) {
  const capGap = Math.max(2, Math.round(CAP_GAP_PT * S));
  const innerGap = Math.max(1, Math.round(INNER_GAP_PT * S));
  let first = null, last = null, gap = 0;
  for (let y = fromRow; y >= 0 && y < rows.length; y += dir) {
    if (rows[y] >= MIN_ROW_INK) {
      if (first === null) first = y;
      last = y;
      gap = 0;
    } else {
      gap++;
      if (first !== null && gap > innerGap) break;
      if (first === null && gap > capGap) break;
    }
  }
  if (first === null) return null;
  return { top: Math.min(first, last), bottom: Math.max(first, last) };
}

/* --------------------------------- main ----------------------------------- */
function dedupeCaptions(captions) {
  const seen = new Map();
  for (const c of captions) {
    const key = `${c.type}:${c.num}`;
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()];
}

function extract(args) {
  const S = args.scale;
  const doc = loadDoc(args.pdf);
  const { nPages, pages, captions: rawCaptions } = collectCaptions(doc);
  const captions = dedupeCaptions(rawCaptions);
  const firstPage = doc.loadPage(0);
  const pageWidth = firstPage.getBounds()[2];

  // ---- title / short name -------------------------------------------------
  let title = '';
  const p0 = [...pages[0].blocks].sort((a, b) => a.bbox[1] - b.bbox[1]);
  for (const b of p0) {
    const t = b.text.replace(/\s+/g, ' ').trim();
    if (t.length >= 8 && b.bbox[1] < pageWidth * 0.5) { title = t; break; }
  }
  const shortName = args.name || suggestShortName(title, path.basename(args.pdf, path.extname(args.pdf)));

  const cols = detectColumns(pages, pageWidth);

  if (args.info) {
    console.log(JSON.stringify({ title, shortName, pages: nPages, columns: cols, captions: captions.map(c => ({ page: c.page + 1, type: c.type, num: c.num })) }, null, 2));
    return { title, shortName, written: [] };
  }

  if (!args.out) throw new Error('Missing --out DIR');
  fs.mkdirSync(args.out, { recursive: true });

  // group captions by page
  const byPage = new Map();
  for (const c of captions) {
    if (!byPage.has(c.page)) byPage.set(c.page, []);
    byPage.get(c.page).push(c);
  }

  const written = [];
  const items = [...captions].sort((a, b) => a.page - b.page || a.bbox[1] - b.bbox[1]);

  for (const [pageIdx, caps] of byPage) {
    const page = doc.loadPage(pageIdx);
    const pix = page.toPixmap(mupdf.Matrix.scale(S, S), mupdf.ColorSpace.DeviceRGB, false, true);
    const png = PNG.sync.read(Buffer.from(pix.asPNG()));
    const mask = buildTextMask(pages[pageIdx].blocks, S, png.width, png.height, TEXT_MASK_PAD_PT);

    for (const cap of caps.sort((a, b) => a.bbox[1] - b.bbox[1])) {
      const span = spanForCaption(cap, cols);
      const rows = graphicRowProfile(png, mask, S, span);

      const capTop = cap.bbox[1] * S;
      const capBot = cap.bbox[3] * S;

      let vTopPt, vBotPt, how = 'graphic';
      const blocks = pages[pageIdx].blocks;
      const hOverlap = (b) => b.bbox[2] >= span[0] - 2 && b.bbox[0] <= span[1] + 2;

      if (cap.type === 'figure') {
        const run = graphicRun(rows, Math.floor(capTop) - 1, -1, S);
        if (run) {
          vTopPt = run.top / S;
          vBotPt = cap.bbox[3];
        } else {
          how = 'fallback';
          vTopPt = textGroupAbove(blocks, cap.bbox[1], span, 20);
          vBotPt = cap.bbox[3];
        }
        // labels inside the figure may stick out just above the shapes
        const above = blocks
          .filter(hOverlap)
          .filter(b => !isBodyParagraph(b, span) && b.bbox[3] <= cap.bbox[1] + 1)
          .sort((a, b) => b.bbox[1] - a.bbox[1]);
        for (const b of above) {
          if (b.bbox[1] >= vTopPt - GROW_TEXT_PT && b.bbox[1] < vTopPt) vTopPt = b.bbox[1];
          else if (b.bbox[1] < vTopPt - GROW_TEXT_PT) break;
        }
      } else {
        const run = graphicRun(rows, Math.ceil(capBot) + 1, 1, S);
        vTopPt = cap.bbox[1];
        vBotPt = run ? run.bottom / S : cap.bbox[3];
        if (!run) how = 'fallback';
        // A rule-only table has graphics at its top/bottom but text in between;
        // pick up the body rows from text blocks whose gap is small and which
        // do not look like a justified body paragraph.
        const textBot = textGroupBelow(blocks, cap.bbox[3], span, 20);
        vBotPt = Math.max(vBotPt, textBot);
        // include the bottom rule if it sits just under the detected content
        for (let y = Math.ceil(vBotPt * S); y <= Math.min(rows.length - 1, Math.ceil((vBotPt + RULE_LOOKAHEAD_PT) * S)); y++) {
          if (rows[y] >= MIN_ROW_INK) { vBotPt = Math.max(vBotPt, y / S); }
        }
      }
      const gTop = vTopPt, gBot = vBotPt;

      const regionPx = [
        span[0] * S,
        Math.max(0, (gTop - PAD_PT) * S),
        span[1] * S,
        Math.min(png.height - 1, (gBot + PAD_PT) * S)
      ];
      const box = trimRegion(png, regionPx);
      if (!box) { console.warn(`  !! ${cap.type} ${cap.num} (p${pageIdx + 1}): empty region`); continue; }

      const pad = Math.round(PAD_PT * S);
      const cx0 = clamp(box[0] - pad, 0, png.width - 1);
      const cy0 = clamp(box[1] - pad, 0, png.height - 1);
      const cx1 = clamp(box[2] + pad, 0, png.width - 1);
      const cy1 = clamp(box[3] + pad, 0, png.height - 1);
      const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;

      const out = new PNG({ width: cw, height: ch });
      for (let y = 0; y < ch; y++) {
        const srow = ((cy0 + y) * png.width + cx0) * 4;
        const drow = y * cw * 4;
        png.data.copy(out.data, drow, srow, srow + cw * 4);
      }
      const fname = `${cap.type === 'table' ? 'Table' : 'Figure'}_${cap.num}.png`;
      const fpath = path.join(args.out, fname);
      fs.writeFileSync(fpath, PNG.sync.write(out));

      const [bx, by, bw, bh] = [cx0 / S, cy0 / S, cw / S, ch / S];
      written.push(fname);
      const tag = how === 'graphic' ? '' : ' [fallback]';
      console.log(`  p${pageIdx + 1} ${fname}: ${bw.toFixed(0)}x${bh.toFixed(0)}pt @ (${bx.toFixed(0)},${by.toFixed(0)})${tag}`);
    }
  }

  console.log(`\nShort name suggestion: ${shortName}`);
  console.log(`Extracted ${written.length} image(s) into ${args.out}`);
  return { title, shortName, written };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pdf) {
    console.error('Usage: node extract.mjs <paper.pdf> --out DIR [--name SHORT] [--scale N] [--info] [--debug]');
    process.exit(2);
  }
  extract(args);
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
