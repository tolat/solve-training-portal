/**
 * Build the Solve completion-certificate template.
 *
 *   node bin/make-certificate-template.mjs [out.pdf]
 *
 * Produces an A4-landscape PDF carrying three AcroForm text fields — `name`,
 * `training` and `date` — which `certificates.js` fills at completion time and
 * then flattens.
 *
 * The template is generated rather than checked in as artwork so the wording,
 * spacing and colours are reviewable in a diff. To use a designer's artwork
 * instead, hand them this spec: any PDF with text fields named `name`,
 * `training` and `date` is filled precisely, and a PDF with no fields at all
 * still works — the portal centres those three on page one.
 *
 * Fonts: Playfair Display (SIL Open Font License, licence beside it in
 * assets/fonts/) carries the title, the name and the training; Helvetica, a
 * standard PDF font that needs no embedding, carries the small letterspaced
 * labels, where a text face adds nothing and would cost 325 KB.
 *
 * Two font traps, both found the hard way and both silent:
 *
 *   1. **The field font must not be subsetted.** A subset only contains the
 *      glyphs drawn at build time, so the first person called Renée or Muñoz
 *      would get a certificate with holes in their name. PlayfairDisplay-Regular
 *      is embedded whole for that reason; the Bold weight is only used for
 *      static text and is safe to subset.
 *   2. **`addToPage({font})` does not set the field's font.** It has to be
 *      `form.updateFieldAppearances(font)` before save, or every field falls
 *      back to Helvetica no matter what was passed in.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const HERE   = path.dirname(fileURLToPath(import.meta.url));
const ROOT   = path.join(HERE, '..');
const FONTS  = path.join(ROOT, 'assets', 'fonts');

// ── Palette ──────────────────────────────────────────────────
const GREEN      = rgb(0x21 / 255, 0x78 / 255, 0x32 / 255); // Solve green, dark variant
const GREEN_DEEP = rgb(0x12 / 255, 0x2b / 255, 0x1a / 255); // near-black green, for text
const GOLD       = rgb(0xb8 / 255, 0x96 / 255, 0x4a / 255);
const GOLD_PALE  = rgb(0xdc / 255, 0xc9 / 255, 0x9b / 255);
const MUTED      = rgb(0.46, 0.49, 0.47);
const HAIRLINE   = rgb(0.80, 0.84, 0.81);
const PAPER      = rgb(1, 1, 1);

const W = 842; // A4 landscape, points
const H = 595;

const out = process.argv[2] || path.join(ROOT, 'assets', 'certificate-template.pdf');

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
doc.setTitle('Solve Energy — Certificate of Completion');
doc.setCreator('Solve Energy');
doc.setProducer('Solve University');

const read = f => fs.readFileSync(path.join(FONTS, f));
// Bold: static text only, so subsetting is safe.
const display    = await doc.embedFont(read('PlayfairDisplay-Bold.ttf'), { subset: true });
// Regular: used by the name and training FIELDS, which hold text nobody has
// seen yet. Embedded whole — see trap 1 above.
const displayReg = await doc.embedFont(read('PlayfairDisplay-Regular.ttf'), { subset: false });
const label      = await doc.embedFont(StandardFonts.Helvetica);
const labelBold  = await doc.embedFont(StandardFonts.HelveticaBold);

const page = doc.addPage([W, H]);

// ── Helpers ──────────────────────────────────────────────────

const centre = (text, font, size, y, color = GREEN_DEEP) => {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: (W - w) / 2, y, size, font, color });
};

/** Letterspaced text, centred. pdf-lib has no tracking, so draw per glyph. */
const centreTracked = (text, font, size, y, tracking, color = GREEN_DEEP) => {
  const chars = [...text];
  const total = chars.reduce((sum, c) => sum + font.widthOfTextAtSize(c, size) + tracking, 0) - tracking;
  let x = (W - total) / 2;
  for (const c of chars) {
    page.drawText(c, { x, y, size, font, color });
    x += font.widthOfTextAtSize(c, size) + tracking;
  }
};

const hrule = (y, halfWidth, color = HAIRLINE, thickness = 0.8) =>
  page.drawLine({
    start: { x: W / 2 - halfWidth, y },
    end:   { x: W / 2 + halfWidth, y },
    thickness, color,
  });

/** A small diamond — the repeated motif in the borders and dividers. */
const diamond = (cx, cy, r, color) =>
  page.drawSvgPath(`M 0 ${-r} L ${r} 0 L 0 ${r} L ${-r} 0 Z`, {
    x: cx, y: cy, color, borderWidth: 0,
  });

// ── Ground and borders ───────────────────────────────────────

page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: PAPER });

// Green bands top and bottom, the only heavy colour on the page
page.drawRectangle({ x: 0, y: H - 14, width: W, height: 14, color: GREEN });
page.drawRectangle({ x: 0, y: 0,      width: W, height: 14, color: GREEN });

// Double frame: a gold hairline just inside a heavier green one
const F1 = 30;   // outer inset
const F2 = 37;   // inner inset
page.drawRectangle({
  x: F1, y: F1, width: W - F1 * 2, height: H - F1 * 2,
  borderColor: GREEN, borderWidth: 1.4,
});
page.drawRectangle({
  x: F2, y: F2, width: W - F2 * 2, height: H - F2 * 2,
  borderColor: GOLD_PALE, borderWidth: 0.6,
});

// Corner diamonds, sitting on the outer frame
for (const [cx, cy] of [[F1, F1], [W - F1, F1], [F1, H - F1], [W - F1, H - F1]]) {
  diamond(cx, cy, 5.5, GREEN);
  diamond(cx, cy, 2.4, GOLD);
}

// ── Wordmark ─────────────────────────────────────────────────

try {
  const png   = await doc.embedPng(fs.readFileSync(path.join(ROOT, 'assets', 'solve-wordmark.png')));
  const logoW = 124;
  const logoH = (png.height / png.width) * logoW;
  page.drawImage(png, { x: (W - logoW) / 2, y: H - 96, width: logoW, height: logoH });
} catch {
  centreTracked('SOLVE', labelBold, 17, H - 88, 3, GREEN_DEEP);
}

centreTracked('SOLVE UNIVERSITY', label, 7.5, H - 110, 2.6, MUTED);

// ── Title ────────────────────────────────────────────────────

centreTracked('CERTIFICATE', display, 33, H - 168, 5.5, GREEN_DEEP);
centreTracked('OF COMPLETION', displayReg, 13.5, H - 196, 6.2, GREEN);

// Flourish: a gold rule broken by a diamond
const FLOURISH_Y = H - 216;
page.drawLine({ start: { x: W / 2 - 92, y: FLOURISH_Y }, end: { x: W / 2 - 14, y: FLOURISH_Y }, thickness: 0.7, color: GOLD });
page.drawLine({ start: { x: W / 2 + 14, y: FLOURISH_Y }, end: { x: W / 2 + 92, y: FLOURISH_Y }, thickness: 0.7, color: GOLD });
diamond(W / 2, FLOURISH_Y, 4, GOLD);

// ── Recipient ────────────────────────────────────────────────

centreTracked('THIS IS TO CERTIFY THAT', label, 8, H - 250, 2.2, MUTED);

const form = doc.getForm();

const nameField = form.createTextField('name');
nameField.addToPage(page, {
  x: 100, y: H - 310, width: W - 200, height: 46,
  borderWidth: 0,
});
nameField.setAlignment(1);
nameField.setFontSize(32);

hrule(H - 318, 250, HAIRLINE);

// ── Training ─────────────────────────────────────────────────

centreTracked('HAS SUCCESSFULLY COMPLETED', label, 8, H - 348, 2.2, MUTED);

const trainingField = form.createTextField('training');
trainingField.addToPage(page, {
  x: 90, y: H - 390, width: W - 180, height: 30,
  borderWidth: 0,
});
trainingField.setAlignment(1);
trainingField.setFontSize(17);

// ── Seal and date, sharing the foot of the page ──────────────
// Mirrored about the centre line so the page doesn't list to one side.

const FOOT_Y  = 104;
const OFFSET  = 172;
const SEAL_X  = W / 2 - OFFSET;
const SEAL_Y  = FOOT_Y + 16;
const DATE_X  = W / 2 + OFFSET;

// Seal
page.drawCircle({ x: SEAL_X, y: SEAL_Y, size: 36, borderColor: GOLD_PALE, borderWidth: 0.8 });
page.drawCircle({ x: SEAL_X, y: SEAL_Y, size: 31, borderColor: GOLD,      borderWidth: 1.6 });
for (let i = 0; i < 28; i++) {                       // scalloped outer edge
  const a = (i / 28) * Math.PI * 2;
  diamond(SEAL_X + Math.cos(a) * 36, SEAL_Y + Math.sin(a) * 36, 1.7, GOLD);
}
try {
  const mark = await doc.embedPng(fs.readFileSync(path.join(ROOT, 'assets', 'solve-mark.png')));
  const d = 29;
  page.drawImage(mark, { x: SEAL_X - d / 2, y: SEAL_Y - d / 2, width: d, height: d });
} catch {
  const t = 'SOLVE', sz = 11;
  page.drawText(t, { x: SEAL_X - display.widthOfTextAtSize(t, sz) / 2, y: SEAL_Y - 4, size: sz, font: display, color: GREEN });
}

// Date, mirrored
const dateField = form.createTextField('date');
dateField.addToPage(page, {
  x: DATE_X - 130, y: FOOT_Y + 12, width: 260, height: 22,
  borderWidth: 0,
});
dateField.setAlignment(1);
dateField.setFontSize(12.5);

page.drawLine({ start: { x: DATE_X - 118, y: FOOT_Y + 8 }, end: { x: DATE_X + 118, y: FOOT_Y + 8 }, thickness: 0.7, color: HAIRLINE });
{
  const t = 'DATE COMPLETED', size = 7, tracking = 2;
  const chars = [...t];
  const total = chars.reduce((a, c) => a + label.widthOfTextAtSize(c, size) + tracking, 0) - tracking;
  let x = DATE_X - total / 2;
  for (const c of chars) {
    page.drawText(c, { x, y: FOOT_Y - 6, size, font: label, color: MUTED });
    x += label.widthOfTextAtSize(c, size) + tracking;
  }
}

// ── Footer line ──────────────────────────────────────────────

centreTracked('ISSUED BY SOLVE ENERGY', label, 7, 54, 2.4, MUTED);

// ── Field typography ─────────────────────────────────────────
// This, not the `font` option on addToPage, is what actually sets the font the
// fields render in. Without it all three fall back to Helvetica.
form.updateFieldAppearances(displayReg);

// ── Save ─────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, await doc.save());
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`✔ certificate template → ${out} (${kb} KB)`);
