import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { PAPER, describeSize, fmtMm, mmToPt, ptToMm } from './paper.js';
import { measurePage } from './measure.js';
import { planDocument } from './plan.js';
import { inspectDocument, applyPlan } from './rewrite.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).toString();

const $ = (id) => document.getElementById(id);

const state = {
  fileName: null,
  bytes: null, // pristine copy, never handed to a library that might detach it
  pdfjsDoc: null,
  measurements: null,
  plan: null,
  thumbs: [],
  warnings: [],
};

const els = {
  drop: $('drop'),
  file: $('file'),
  panel: $('panel'),
  status: $('status'),
  warnings: $('warnings'),
  summary: $('summary'),
  rows: $('rows'),
  build: $('build'),
  reset: $('reset'),
  target: $('target'),
  anchor: $('anchor'),
  margin: $('margin'),
  denoise: $('denoise'),
  dpi: $('dpi'),
  globalScale: $('globalScale'),
  fullBleed: $('fullBleed'),
};

// ---------------------------------------------------------------- file intake

els.drop.addEventListener('click', () => els.file.click());
els.drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.drop.classList.add('over');
});
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  els.drop.classList.remove('over');
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});
els.file.addEventListener('change', () => {
  const file = els.file.files?.[0];
  if (file) loadFile(file);
});

for (const el of [els.target, els.anchor, els.margin, els.denoise, els.globalScale, els.fullBleed]) {
  el.addEventListener('change', () => replan());
}
els.dpi.addEventListener('change', () => remeasure());
els.build.addEventListener('click', () => build());
els.reset.addEventListener('click', () => location.reload());

async function loadFile(file) {
  if (!/\.pdf$/i.test(file.name)) {
    setStatus('That does not look like a PDF.', 'error');
    return;
  }
  state.fileName = file.name;
  setStatus(`Reading ${file.name}…`);

  const buffer = await file.arrayBuffer();
  state.bytes = new Uint8Array(buffer);

  if (state.bytes.byteLength > 150 * 1024 * 1024) {
    setStatus(
      'This file is over 150 MB. Everything runs in your browser tab, so it may run out of memory — proceeding anyway.',
      'warn',
    );
  }

  try {
    await analyse();
  } catch (err) {
    console.error(err);
    setStatus(`Could not read this PDF: ${err.message}`, 'error');
  }
}

async function analyse() {
  // pdf.js needs its own copy: it transfers the buffer to its worker.
  state.pdfjsDoc = await pdfjsLib.getDocument({
    data: state.bytes.slice(),
    isEvalSupported: false,
  }).promise;

  const probe = await window.PDFLib.PDFDocument.load(state.bytes.slice(), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const inspection = inspectDocument(probe);
  state.warnings = inspection.warnings;

  if (inspection.fatal) {
    renderWarnings([{ key: 'fatal', text: inspection.fatal, level: 'error' }]);
    setStatus('Cannot process this file.', 'error');
    els.panel.hidden = false;
    els.build.disabled = true;
    return;
  }

  els.panel.hidden = false;
  els.build.disabled = false;
  await remeasure();
}

// ------------------------------------------------------------------ measuring

async function remeasure() {
  const doc = state.pdfjsDoc;
  if (!doc) return;

  const dpi = Number(els.dpi.value);
  const measureCanvas = document.createElement('canvas');
  const measurements = [];
  const thumbs = [];

  els.build.disabled = true;

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const result = await measurePage(page, measureCanvas, {
      dpi,
      denoise: Number(els.denoise.value),
    });
    measurements.push({ ...result, rotate: page.rotate });
    thumbs.push(await makeThumb(page));
    page.cleanup();

    if (i % 4 === 0 || i === doc.numPages) {
      setStatus(`Measuring ink coverage… ${i}/${doc.numPages}`);
      await yieldToUi();
    }
  }

  state.measurements = measurements;
  state.thumbs = thumbs;
  els.build.disabled = false;
  replan();
}

async function makeThumb(page, maxEdge = 320) {
  // Rendered with the page's own rotation, because this is what a human
  // recognises as "the page" — the measurement pass deliberately does not.
  const base = page.getViewport({ scale: 1 });
  const scale = maxEdge / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
  return canvas;
}

const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

// ------------------------------------------------------------------- planning

function replan() {
  if (!state.measurements) return;

  const paper = PAPER[els.target.value];
  state.plan = planDocument(state.measurements, paper, {
    anchor: els.anchor.value,
    globalScale: els.globalScale.checked,
    safetyMarginPt: mmToPt(Number(els.margin.value) || 0),
    fullBleedMode: els.fullBleed.value,
  });

  renderSummary();
  renderWarnings(collectWarnings());
  renderRows();
  setStatus(`${state.fileName} — ${state.plan.length} page(s) ready.`, 'ok');

  // Test hook: the suite drives the real page rather than the modules in
  // isolation, so it needs somewhere to read the computed plan from.
  window.__paperResize = { plan: state.plan, measurements: state.measurements };
}

function collectWarnings() {
  const warnings = state.warnings.map((w) => ({ ...w, level: 'warn' }));
  const plan = state.plan ?? [];

  const scaled = plan.filter((p) => p.scale < 1);
  if (scaled.length) {
    const worst = Math.min(...scaled.map((p) => p.scale));
    warnings.push({
      key: 'scaled',
      level: 'warn',
      text:
        `${scaled.length} page(s) have ink that genuinely does not fit, so the document is ` +
        `scaled to ${(worst * 100).toFixed(1)}%. This is the largest factor that loses nothing — ` +
        `the only way to keep true 100% would be to re-lay-out the source document.`,
    });
  }

  const bleed = plan.filter((p) => p.isFullBleed);
  if (bleed.length) {
    warnings.push({
      key: 'bleed',
      level: 'info',
      text:
        `${bleed.length} page(s) have a full-bleed background. Their whole sheet counts as ink, ` +
        `so they cannot be placed at 100% — choose "fill" if you would rather crop the bleed than ` +
        `leave a white border.`,
    });
  }

  const mixed = new Set(plan.map((p) => `${Math.round(p.sourceDisplay.w)}x${Math.round(p.sourceDisplay.h)}`));
  if (mixed.size > 1) {
    warnings.push({
      key: 'mixed',
      level: 'info',
      text: `This document mixes ${mixed.size} different page sizes. Each is fitted to the target on its own.`,
    });
  }

  return warnings;
}

// ------------------------------------------------------------------ rendering

function setStatus(text, level = '') {
  els.status.textContent = text;
  els.status.className = `status ${level}`;
}

function renderWarnings(list) {
  els.warnings.innerHTML = '';
  for (const w of list) {
    const div = document.createElement('div');
    div.className = `notice ${w.level ?? 'warn'}`;
    div.textContent = w.text;
    els.warnings.append(div);
  }
}

function renderSummary() {
  const plan = state.plan;
  const untouched = plan.filter((p) => p.action === 'skip').length;
  const translated = plan.filter((p) => p.action === 'translate').length;
  const scaled = plan.filter((p) => p.action === 'scale');
  const scale = scaled.length ? Math.min(...scaled.map((p) => p.scale)) : 1;

  const parts = [];
  if (translated) parts.push(`<b>${translated}</b> repositioned at true <b>100%</b>`);
  if (untouched) parts.push(`<b>${untouched}</b> already correct, left untouched`);
  if (scaled.length) parts.push(`<b>${scaled.length}</b> scaled to <b>${(scale * 100).toFixed(1)}%</b>`);

  const verdict = scaled.length
    ? 'Some content could not be preserved at full size.'
    : 'Nothing is scaled — every page keeps its exact original size.';

  els.summary.innerHTML = `<div class="verdict ${scaled.length ? 'partial' : 'clean'}">${verdict}</div>
    <div class="breakdown">${parts.join(' · ')}</div>`;
}

function renderRows() {
  els.rows.innerHTML = '';
  const frag = document.createDocumentFragment();

  state.plan.forEach((step, i) => {
    const row = document.createElement('div');
    row.className = 'row';

    const src = describeSize(step.sourceDisplay.w, step.sourceDisplay.h);
    const badge =
      step.action === 'scale'
        ? `<span class="badge scale">scaled ${(step.scale * 100).toFixed(1)}%</span>`
        : step.action === 'skip'
          ? '<span class="badge skip">unchanged</span>'
          : '<span class="badge keep">100%</span>';

    const lost = step.overflow.h > 0.5 || step.overflow.w > 0.5
      ? `<div class="lost">Would have lost ${fmtMm(Math.max(step.overflow.w, step.overflow.h))} without scaling</div>`
      : '';

    row.innerHTML = `
      <div class="rowhead">
        <span class="pageno">p.${i + 1}</span>
        ${badge}
        ${step.blank ? '<span class="badge blank">blank</span>' : ''}
        ${step.isFullBleed ? '<span class="badge bleed">full bleed</span>' : ''}
        ${step.rotate ? `<span class="badge rot">/Rotate ${step.rotate}</span>` : ''}
      </div>
      <div class="rowbody">
        <figure><figcaption>source ${src.label ?? ''} — dashed line is where ${PAPER[els.target.value].label} ends</figcaption></figure>
        <figure><figcaption>result</figcaption></figure>
      </div>
      <div class="meta">
        <span>${Math.round(step.sourceDisplay.w)}×${Math.round(step.sourceDisplay.h)} pt → ${Math.round(step.paperBox.w)}×${Math.round(step.paperBox.h)} pt</span>
        <span>top margin ${fmtMm(step.margins.top)} · bottom ${fmtMm(step.margins.bottom)}</span>
      </div>
      ${lost}`;

    const figures = row.querySelectorAll('figure');
    figures[0].prepend(drawSource(step, state.thumbs[i]));
    figures[1].prepend(drawResult(step, state.thumbs[i]));
    frag.append(row);
  });

  els.rows.append(frag);
}

const VIEW = 172; // px on the long edge of a preview

/** Source page with the detected ink box and the target's cut line drawn on. */
function drawSource(step, thumb) {
  const { w, h } = step.sourceDisplay;
  const k = VIEW / Math.max(w, h);
  const vw = w * k;
  const vh = h * k;
  const { canvas, ctx } = makeCanvas(vw, vh);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, vw, vh);
  if (thumb) ctx.drawImage(thumb, 0, 0, vw, vh);

  const toY = (y) => (h - y) * k; // PDF y is up, canvas y is down

  if (!step.blank) {
    ctx.strokeStyle = 'rgba(56,142,255,.95)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      step.inkDisplay[0] * k,
      toY(step.inkDisplay[3]),
      (step.inkDisplay[2] - step.inkDisplay[0]) * k,
      (step.inkDisplay[3] - step.inkDisplay[1]) * k,
    );
  }

  // Where the target paper would cut if you simply swapped the page size and
  // kept the top-left corner — the failure mode this tool exists to avoid.
  // Either axis can overflow: A4 is taller than Letter, but landscape A4 is
  // wider than landscape Letter.
  ctx.strokeStyle = 'rgba(255,86,86,.95)';
  ctx.fillStyle = 'rgba(255,86,86,.13)';

  const cutY = h - step.paperBox.h;
  if (cutY > 0.5) {
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, toY(cutY));
    ctx.lineTo(vw, toY(cutY));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillRect(0, toY(cutY), vw, vh - toY(cutY));
  }

  const cutX = step.paperBox.w;
  if (w - cutX > 0.5) {
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(cutX * k, 0);
    ctx.lineTo(cutX * k, vh);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillRect(cutX * k, 0, vw - cutX * k, vh);
  }

  return canvas;
}

/** The target sheet with the source page placed on it exactly as planned. */
function drawResult(step, thumb) {
  const { w, h } = step.paperBox;
  const k = VIEW / Math.max(w, h);
  const vw = w * k;
  const vh = h * k;
  const { canvas, ctx } = makeCanvas(vw, vh);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, vw, vh);

  // Recover the display-space placement from the ink box and where it landed.
  const s = step.scale;
  const tx = step.placedInk[0] - s * step.inkDisplay[0];
  const ty = step.placedInk[1] - s * step.inkDisplay[1];
  const pw = step.sourceDisplay.w * s;
  const ph = step.sourceDisplay.h * s;

  if (thumb) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, vw, vh); // full-bleed "fill" can overflow the sheet
    ctx.clip();
    ctx.drawImage(thumb, tx * k, (h - ty - ph) * k, pw * k, ph * k);
    ctx.restore();
  }

  ctx.strokeStyle = 'rgba(127,127,127,.55)';
  ctx.strokeRect(0.5, 0.5, vw - 1, vh - 1);
  return canvas;
}

/**
 * Backing store at device resolution, drawing coordinates in CSS pixels. All
 * callers work in the logical (vw, vh) space they passed in.
 */
function makeCanvas(vw, vh) {
  const canvas = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(vw * dpr));
  canvas.height = Math.max(1, Math.round(vh * dpr));
  canvas.style.width = `${Math.round(vw)}px`;
  canvas.style.height = `${Math.round(vh)}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { canvas, ctx };
}

// -------------------------------------------------------------------- output

async function build() {
  if (!state.plan) return;
  els.build.disabled = true;
  setStatus('Rewriting…');
  await yieldToUi();

  try {
    // Always start from the pristine bytes so that changing an option and
    // rebuilding never stacks one transform on top of another.
    const pdfDoc = await window.PDFLib.PDFDocument.load(state.bytes.slice(), {
      ignoreEncryption: true,
      updateMetadata: false,
    });

    const stats = applyPlan(pdfDoc, state.plan);

    const out = await pdfDoc.save({
      // pdf-lib otherwise regenerates every form field's appearance with its own
      // fonts, which is a far more destructive edit than the one we came to make.
      updateFieldAppearances: false,
    });

    download(out, state.fileName.replace(/\.pdf$/i, '') + `-${els.target.value}.pdf`);
    setStatus(
      `Done — ${stats.rewritten} page(s) rewritten, ${stats.skipped} left untouched, ` +
        `${stats.annotations} annotation(s) and ${stats.destinations} destination(s) remapped.`,
      'ok',
    );
  } catch (err) {
    console.error(err);
    setStatus(`Rewrite failed: ${err.message}`, 'error');
  } finally {
    els.build.disabled = false;
  }
}

function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Populate the paper picker from the shared table.
for (const [key, paper] of Object.entries(PAPER)) {
  const option = document.createElement('option');
  option.value = key;
  option.textContent = `${paper.label} — ${ptToMm(paper.w).toFixed(0)} × ${ptToMm(paper.h).toFixed(0)} mm`;
  if (key === 'letter') option.selected = true;
  els.target.append(option);
}
