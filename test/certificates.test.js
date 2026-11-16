// Certificate generation — offline. No network, no Notion.
//
// Covers the parts that are easy to get wrong and expensive to discover in
// production: the timezone trap on the completion date, filling a template that
// has form fields versus one that does not, idempotency, and the rule that a
// certificate failure must never fail the completion that earned it.

const { test } = require('node:test');
const assert   = require('node:assert');
const PDFLib   = require('pdf-lib');

const { createCertificates, formatDate, certificateFileName } = require('../certificates');

const silent = { log() {}, warn() {}, error() {} };

/** A one-page PDF, optionally carrying `name` and `date` AcroForm text fields. */
async function makeTemplate({ withFormFields = false } = {}) {
  const doc  = await PDFLib.PDFDocument.create();
  const page = doc.addPage([842, 595]); // A4 landscape, a certificate shape
  page.drawText('Certificate of Completion', { x: 220, y: 480, size: 24 });

  if (withFormFields) {
    const form = doc.getForm();
    form.createTextField('name').addToPage(page,     { x: 150, y: 300, width: 540, height: 36 });
    form.createTextField('date').addToPage(page,     { x: 150, y: 220, width: 540, height: 24 });
    form.createTextField('training').addToPage(page, { x: 150, y: 260, width: 540, height: 28 });
  }
  return Buffer.from(await doc.save());
}

/**
 * Read the text actually rendered in the PDF.
 *
 * Content streams are Flate-compressed, so searching the raw bytes finds
 * nothing even when the text is there — the same extractor the portal uses for
 * quiz generation is the honest check.
 */
let pdfjsLib;
async function textOf(bytes) {
  if (!pdfjsLib) {
    const warn = console.warn;
    console.warn = (...a) => { if (!/polyfill/i.test(String(a[0]))) warn(...a); };
    try { pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js'); } finally { console.warn = warn; }
  }
  const buf  = Buffer.from(bytes);
  const data = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const doc  = await pdfjsLib.getDocument({ data, useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    let out = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      for (const it of tc.items) out += it.str + ' ';
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

/** The first rendered text item containing `needle`, with its measured width. */
async function textItem(bytes, needle) {
  if (!pdfjsLib) {
    const warn = console.warn;
    console.warn = (...a) => { if (!/polyfill/i.test(String(a[0]))) warn(...a); };
    try { pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js'); } finally { console.warn = warn; }
  }
  const buf  = Buffer.from(bytes);
  const data = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const doc  = await pdfjsLib.getDocument({ data, useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const tc = await (await doc.getPage(1)).getTextContent();
    return tc.items.find(i => i.str && i.str.includes(needle)) || null;
  } finally {
    await doc.destroy();
  }
}

// ─── date formatting ──────────────────────────────────────────

test('formatDate renders the calendar date, not a timezone-shifted one', () => {
  // new Date('2026-11-11') is UTC midnight — in BC that is 2026-11-10.
  // A certificate dated the day before the training is a support ticket.
  assert.strictEqual(formatDate('2026-11-11'), '11 November 2026');
  assert.strictEqual(formatDate('2026-01-01'), '1 January 2026');
  assert.strictEqual(formatDate('2026-12-31'), '31 December 2026');
});

test('formatDate tolerates a full ISO timestamp and junk', () => {
  assert.strictEqual(formatDate('2026-06-05T18:30:00.000Z'), '5 June 2026');
  assert.strictEqual(formatDate(''), '');
  assert.strictEqual(formatDate(null), '');
  assert.strictEqual(formatDate('not a date'), 'not a date');
});

// ─── file naming ──────────────────────────────────────────────

test('certificateFileName strips characters that break on Windows or in URLs', () => {
  const n = certificateFileName('Fall Protection / Working at Heights', 'Ana O\'Brien-Smith', '2026-11-11');
  assert.ok(n.endsWith('.pdf'), n);
  assert.ok(!/[\/\\:*?"<>|']/.test(n), `unsafe characters survived: ${n}`);
  assert.ok(n.includes('2026-11-11'), n);
});

test('certificateFileName survives an empty block name', () => {
  const n = certificateFileName('', 'Sam Harris', '2026-11-11');
  assert.ok(n.startsWith('Certificate_'), n);
  assert.ok(n.endsWith('.pdf'), n);
});

// ─── filling ──────────────────────────────────────────────────

test('a template with form fields gets them filled and flattened', async () => {
  const certs = createCertificates({ PDFLib, log: silent });
  const out = await certs.fill(await makeTemplate({ withFormFields: true }), {
    personName:   'Priya Raman',
    dateISO:      '2026-11-11',
    trainingName: 'Fall Protection',
  });

  assert.strictEqual(out.placedWith, 'form-fields');

  const doc = await PDFLib.PDFDocument.load(out.bytes, { ignoreEncryption: true });
  // Flattened: the fields are gone, so nobody can retype their own name.
  assert.strictEqual(doc.getForm().getFields().length, 0, 'form should be flattened');

  const text = await textOf(out.bytes);
  assert.ok(text.includes('Priya Raman'),      'name missing from the filled PDF');
  assert.ok(text.includes('11 November 2026'), 'date missing from the filled PDF');
  assert.ok(text.includes('Fall Protection'),  'training name missing from the filled PDF');
});

test('the real shipped template fills correctly', async () => {
  // Guards the template itself: a regenerated template that loses or renames a
  // field would otherwise only show up on someone's certificate.
  const fs    = require('node:fs');
  const path  = require('node:path');
  const file  = path.join(__dirname, '..', 'assets', 'certificate-template.pdf');
  if (!fs.existsSync(file)) return; // not built in this checkout

  const certs = createCertificates({ PDFLib, log: silent });
  const out   = await certs.fill(fs.readFileSync(file), {
    personName:   'Aldrin Dela Cruz',
    dateISO:      '2026-11-12',
    trainingName: 'Asbestos Awareness',
  });

  assert.strictEqual(out.placedWith, 'form-fields', 'the shipped template should have form fields');
  const text = await textOf(out.bytes);
  assert.ok(text.includes('Aldrin Dela Cruz'),  'name not filled on the shipped template');
  assert.ok(text.includes('12 November 2026'),  'date not filled on the shipped template');
  assert.ok(text.includes('Asbestos Awareness'),'training not filled on the shipped template');
});

test('a template with no form fields falls back to centred text', async () => {
  const certs = createCertificates({ PDFLib, log: silent });
  const out = await certs.fill(await makeTemplate(), {
    personName:   'Priya Raman',
    dateISO:      '2026-11-11',
    trainingName: 'Fall Protection',
  });

  assert.strictEqual(out.placedWith, 'centred-text');
  const text = await textOf(out.bytes);
  assert.ok(text.includes('Priya Raman'),     'name was not drawn');
  assert.ok(text.includes('Fall Protection'), 'training name was not drawn');
});

test('a very long name is shrunk rather than running off the page', async () => {
  const certs = createCertificates({ PDFLib, log: silent });
  const long  = 'Bartholomew Maximilian Fitzgerald-Montgomery III';
  const out   = await certs.fill(await makeTemplate(), { personName: long, dateISO: '2026-11-11' });
  // It must not throw, and the output must still be a loadable single-page PDF.
  const doc = await PDFLib.PDFDocument.load(out.bytes, { ignoreEncryption: true });
  assert.strictEqual(doc.getPageCount(), 1);
});

// ─── issue(): orchestration, with Notion mocked ───────────────

function mockDeps({ templateFiles, recordFiles = [], onPatch = () => {}, uploadThrows = false }) {
  const calls = { uploads: 0, patches: 0 };
  return {
    calls,
    deps: {
      PDFLib,
      log: silent,
      async notionFetch(endpoint, method = 'GET', body = null) {
        if (method === 'PATCH') {
          calls.patches++;
          onPatch(body);
          return { properties: { 'Internal Certificates': { files: [{ type: 'file', name: 'c.pdf', file: { url: 'https://notion.example/c.pdf' } }] } } };
        }
        if (endpoint.includes('/pages/block')) {
          return { properties: { 'Name': { title: [{ plain_text: 'Fall Protection' }] }, 'Certificate Template': { files: templateFiles } } };
        }
        return { properties: { 'Internal Certificates': { files: recordFiles } } };
      },
      async uploadBytesToNotion() {
        calls.uploads++;
        if (uploadThrows) throw new Error('Notion upload failed (503)');
        return 'upload-id-1';
      },
      notionFileRef: (id, name) => ({ name, type: 'file_upload', file_upload: { id } }),
      async fetchFile() {
        return { ok: true, arrayBuffer: async () => await makeTemplate({ withFormFields: true }) };
      },
    },
  };
}

const TEMPLATE_FILE = [{ type: 'file', name: 'template.pdf', file: { url: 'https://notion.example/template.pdf' } }];

test('a block with no template issues nothing, quietly', async () => {
  const { deps, calls } = mockDeps({ templateFiles: [] });
  const certs = createCertificates(deps);
  const result = await certs.issue({ blockId: 'block1', recordId: 'rec1', personName: 'Sam', dateISO: '2026-11-11' });
  assert.strictEqual(result, null);
  assert.strictEqual(calls.uploads, 0, 'nothing should have been uploaded');
  assert.strictEqual(calls.patches, 0, 'the record should not have been touched');
});

test('a block with a template issues one, and returns a usable url', async () => {
  const { deps, calls } = mockDeps({ templateFiles: TEMPLATE_FILE });
  const certs = createCertificates(deps);
  const result = await certs.issue({ blockId: 'block1', recordId: 'rec1', personName: 'Sam Harris', dateISO: '2026-11-11' });

  assert.ok(result, 'expected a certificate');
  assert.strictEqual(result.blockName, 'Fall Protection');
  assert.strictEqual(result.placedWith, 'form-fields');
  assert.ok(result.url, 'the caller needs a url to show it');
  assert.ok(result.name.endsWith('.pdf'));
  assert.strictEqual(calls.uploads, 1);
  assert.strictEqual(calls.patches, 1);
});

test('it writes Internal Certificates, never Certificates', async () => {
  let patched = null;
  const { deps } = mockDeps({ templateFiles: TEMPLATE_FILE, onPatch: b => { patched = b; } });
  const certs = createCertificates(deps);
  await certs.issue({ blockId: 'block1', recordId: 'rec1', personName: 'Sam', dateISO: '2026-11-11' });

  assert.ok(patched.properties['Internal Certificates'], 'should write Internal Certificates');
  assert.strictEqual(patched.properties['Certificates'], undefined,
    'must never touch Certificates — that field holds what the trainee uploaded as proof');
});

test('re-completing a module does not issue a second certificate', async () => {
  const existing = [{ type: 'file', name: 'already.pdf', file: { url: 'https://notion.example/already.pdf' } }];
  const { deps, calls } = mockDeps({ templateFiles: TEMPLATE_FILE, recordFiles: existing });
  const certs = createCertificates(deps);

  const result = await certs.issue({ blockId: 'block1', recordId: 'rec1', personName: 'Sam', dateISO: '2026-11-11' });
  assert.strictEqual(result, null);
  assert.strictEqual(calls.uploads, 0);
  assert.strictEqual(calls.patches, 0);
});

test('force: true reissues over an existing certificate', async () => {
  const existing = [{ type: 'file', name: 'already.pdf', file: { url: 'https://notion.example/already.pdf' } }];
  const { deps, calls } = mockDeps({ templateFiles: TEMPLATE_FILE, recordFiles: existing });
  const certs = createCertificates(deps);

  const result = await certs.issue({ blockId: 'block1', recordId: 'rec1', personName: 'Sam', dateISO: '2026-11-11', force: true });
  assert.ok(result);
  assert.strictEqual(calls.uploads, 1);
});

test('an upload failure returns null instead of throwing', async () => {
  // The completion is already recorded by the time we get here. Throwing would
  // turn a finished training into a 500 the person sees as a failure.
  const { deps } = mockDeps({ templateFiles: TEMPLATE_FILE, uploadThrows: true });
  const certs = createCertificates(deps);
  const result = await certs.issue({ blockId: 'block1', recordId: 'rec1', personName: 'Sam', dateISO: '2026-11-11' });
  assert.strictEqual(result, null);
});

test('a missing recordId or blockId is a no-op, not a crash', async () => {
  const { deps } = mockDeps({ templateFiles: TEMPLATE_FILE });
  const certs = createCertificates(deps);
  assert.strictEqual(await certs.issue({ blockId: null, recordId: 'rec1', personName: 'Sam' }), null);
  assert.strictEqual(await certs.issue({ blockId: 'block1', recordId: null, personName: 'Sam' }), null);
});

// ─── the shipped template's typography ────────────────────────
// Both of these guard bugs that shipped silently once already: the filled text
// came out in Helvetica instead of the display face, and a subsetted font
// punched holes through any name with an accent in it.

const FS   = require('node:fs');
const PATH = require('node:path');
const TEMPLATE = PATH.join(__dirname, '..', 'assets', 'certificate-template.pdf');
const FIELD_FONT = PATH.join(__dirname, '..', 'assets', 'fonts', 'Allura-Regular.ttf');  // the NAME field's face

// Mirrors how server.js wires the faces: one per field role.
const withFieldFont = () => createCertificates({
  PDFLib,
  log: silent,
  fieldFonts: {
    name:     FS.readFileSync(FIELD_FONT),
    training: FS.readFileSync(PATH.join(__dirname, '..', 'assets', 'fonts', 'Inter-SemiBold.ttf')),
    date:     FS.readFileSync(PATH.join(__dirname, '..', 'assets', 'fonts', 'Inter-Regular.ttf')),
    default:  FS.readFileSync(PATH.join(__dirname, '..', 'assets', 'fonts', 'Inter-SemiBold.ttf')),
  },
  fontkit: require('@pdf-lib/fontkit'),
});

test('filled fields render in the display face, not Helvetica', async () => {
  if (!FS.existsSync(TEMPLATE) || !FS.existsSync(FIELD_FONT)) return;

  // `form.flatten()` regenerates every appearance in pdf-lib's DEFAULT font
  // unless it is handed one, which is exactly how this shipped broken once.
  //
  // Asserting "the display face is among the page fonts" does NOT catch it —
  // the title uses that face either way, so the assertion passes while the name
  // is set in Helvetica. Measure the name instead: at 42pt this string is 346pt
  // in Allura and 411pt in Helvetica, a 16% gap nothing can close.
  const NAME = 'Wilhelmina Fitzwilliam';
  const NAME_PT = 42;                 // must match nameField.setFontSize()

  const probe   = await PDFLib.PDFDocument.create();
  probe.registerFontkit(require('@pdf-lib/fontkit'));
  const display   = await probe.embedFont(FS.readFileSync(FIELD_FONT), { subset: false });
  const helvetica = await probe.embedFont(PDFLib.StandardFonts.Helvetica);
  const wantDisplay   = display.widthOfTextAtSize(NAME, NAME_PT);
  const wantHelvetica = helvetica.widthOfTextAtSize(NAME, NAME_PT);

  const out = await withFieldFont().fill(FS.readFileSync(TEMPLATE), {
    personName: NAME, dateISO: '2026-11-16', trainingName: 'Asbestos Awareness',
  });

  const item = await textItem(out.bytes, 'Wilhelmina');
  assert.ok(item, 'the name was not found in the rendered certificate');

  const offBy = f => Math.abs(item.width - f) / f;
  assert.ok(offBy(wantDisplay) < 0.02,
    `name measured ${item.width.toFixed(1)}pt; the display face sets it at ${wantDisplay.toFixed(1)}pt`);
  assert.ok(offBy(wantHelvetica) > 0.02,
    `name measured ${item.width.toFixed(1)}pt, indistinguishable from Helvetica (${wantHelvetica.toFixed(1)}pt) — the field font was not applied`);
});

test('a name with accents survives the embedded font', async () => {
  if (!FS.existsSync(TEMPLATE) || !FS.existsSync(FIELD_FONT)) return;

  // Two separate failures live here.
  //
  // A subsetted field font carries only the glyphs drawn at build time, so the
  // first Renée or Muñoz would get holes punched through their own name.
  //
  // And a face can carry the glyph but render it with a broken advance: Great
  // Vibes draws a precomposed é a clear space away from the letter before it,
  // so "Renée" comes out as "Ren ée". pdf-lib's own metrics do NOT show that —
  // it measures the string correctly — so the only way to catch it is to
  // compare what was RENDERED against what the font says it should measure.
  const NAME = 'Renée Muñoz-O’Regan';
  const NAME_PT = 42;

  const out = await withFieldFont().fill(FS.readFileSync(TEMPLATE), {
    personName: NAME, dateISO: '2026-11-16', trainingName: 'Asbestos Awareness',
  });

  const text = (await textOf(out.bytes)).replace(/\s+/g, ' ');
  for (const ch of ['Renée', 'Muñoz']) {
    assert.ok(text.includes(ch), `"${ch}" missing from the rendered certificate — font subsetting?`);
  }

  const probe = await PDFLib.PDFDocument.create();
  probe.registerFontkit(require('@pdf-lib/fontkit'));
  const face  = await probe.embedFont(FS.readFileSync(FIELD_FONT), { subset: false });
  const want  = face.widthOfTextAtSize(NAME, NAME_PT);

  const item = await textItem(out.bytes, 'Renée');
  assert.ok(item, 'the accented name was not found in the rendered certificate');
  assert.ok(Math.abs(item.width - want) / want < 0.03,
    `accented name rendered ${item.width.toFixed(1)}pt but the face measures it at ${want.toFixed(1)}pt — a glyph is rendering with a broken advance`);
});

test('the static labels are not missing glyphs', async () => {
  if (!FS.existsSync(TEMPLATE)) return;
  // Subsetting silently dropped most letters from the label face once; these
  // strings are drawn glyph by glyph for letterspacing, which is what broke.
  const text = (await textOf(FS.readFileSync(TEMPLATE))).replace(/\s+/g, '');
  for (const phrase of ['CERTIFICATE', 'OFCOMPLETION', 'THISCERTIFICATEISPRESENTEDTO',
                        'HASSUCCESSFULLYCOMPLETED', 'DATE', 'SIGNATURE', 'KaneHammontree,CEO']) {
    assert.ok(text.includes(phrase), `label "${phrase}" is incomplete in the template`);
  }
});
