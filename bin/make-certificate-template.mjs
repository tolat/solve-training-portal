/**
 * Build the Solve completion-certificate template.
 *
 *   node bin/make-certificate-template.mjs [out.pdf]
 *
 * Produces an A4-landscape PDF carrying three AcroForm text fields — `name`,
 * `training` and `date` — which `certificates.js` fills at completion time and
 * then flattens.
 *
 * DESIGN: the artwork is a supplied base plate, `assets/certificate-base.png`
 * — green corner wedges, gold frame, gold seal and a guilloche ground. It is
 * drawn full-bleed and everything below is typeset on top of it.
 *
 * **Do not try to redraw that plate.** Three attempts at reproducing the
 * guilloche by hand all came out as random scribble rather than the plate's
 * even swoops; it is a plotted pattern and it belongs as an image.
 *
 * The layout below is pinned to the plate's own geometry, measured from the
 * image rather than guessed (all in points, A4 landscape 842 × 595):
 *
 *   top-right wedge     a shallow triangle, (460, 595) to (842, 515)
 *   gold seal           a disc, x 655–790, y 480–575
 *   bottom-left wedge   a triangle, (0, 85) to (395, 0)
 *
 * So the clear column for type is roughly x 60–790, y 100–500, and the foot
 * has to stay above y ≈ 100 or it runs into the bottom-left wedge.
 *
 * Font traps, all silent, all covered by test/certificates.test.js:
 *
 *   1. **The field fonts must not be subsetted.** A subset only contains the
 *      glyphs drawn at build time, so the first person called Renée or Muñoz
 *      would get holes punched through their own name.
 *   2. **`addToPage({font})` does not set a field's font.** It has to be
 *      `form.updateFieldAppearances(font)` before save, and `certificates.js`
 *      has to re-apply it per field before flattening, or everything falls
 *      back to Helvetica while the static title still looks right.
 *   3. **A text field paints its own background, white by default.** Over the
 *      plate's guilloche that shows as a pale box around every value — near-
 *      white is not good enough, it has to be absent. `transparent()` strips
 *      the widget's /MK appearance dictionary so nothing is painted at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.join(HERE, '..');
const FONTS = path.join(ROOT, 'assets', 'fonts');

const hex = h => rgb(
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
);

const INK   = hex('#1a1a1a');
const BODY  = hex('#3a3a3a');
const GREEN = hex('#0d6b24');   // sampled from the plate's wedges
const RULE  = rgb(0.38, 0.38, 0.38);

const W = 842;
const H = 595;

const out = process.argv[2] || path.join(ROOT, 'assets', 'certificate-template.pdf');

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
doc.setTitle('Solve Energy — Certificate of Completion');
doc.setCreator('Solve Energy');
doc.setProducer('Solve University');

const read = f => fs.readFileSync(path.join(FONTS, f));
// Embedded whole: these render the name and training FIELDS, which hold text
// nobody has typed yet — and subsetting corrupts these TTFs anyway.
const script  = await doc.embedFont(read('Allura-Regular.ttf'), { subset: false });
const bold    = await doc.embedFont(read('Inter-Bold.ttf'),     { subset: false });
const semi    = await doc.embedFont(read('Inter-SemiBold.ttf'), { subset: false });
const regular = await doc.embedFont(read('Inter-Regular.ttf'),  { subset: false });

const page = doc.addPage([W, H]);

// ── Helpers ──────────────────────────────────────────────────

const centreAt = (text, font, size, y, color, cx = W / 2) => {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: cx - w / 2, y, size, font, color });
};

/** Letterspaced text, centred. pdf-lib has no tracking, so draw per glyph. */
const tracked = (text, font, size, y, trackPt, color, cx = W / 2) => {
  const chars = [...text];
  const total = chars.reduce((s, c) => s + font.widthOfTextAtSize(c, size) + trackPt, 0) - trackPt;
  let x = cx - total / 2;
  for (const c of chars) {
    page.drawText(c, { x, y, size, font, color });
    x += font.widthOfTextAtSize(c, size) + trackPt;
  }
};

const hline = (x1, x2, y, color = RULE, thickness = 0.9) =>
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });

/**
 * Remove a field's background entirely.
 *
 * Passing `backgroundColor: undefined` stops pdf-lib writing a /BG entry, but
 * the widget still carries an /MK dictionary; dropping it outright is what
 * guarantees nothing is painted behind the value. Over the plate's guilloche
 * even a near-white fill reads as a box.
 */
const transparent = field => {
  for (const widget of field.acroField.getWidgets()) widget.dict.delete(PDFName.of('MK'));
};

// ── The plate ────────────────────────────────────────────────

const plate = await doc.embedPng(fs.readFileSync(path.join(ROOT, 'assets', 'certificate-base.png')));
page.drawImage(plate, { x: 0, y: 0, width: W, height: H });

// ── Wordmark ─────────────────────────────────────────────────
// Top-left: the plate's seal sits top-right and the wedge only reaches down to
// y 527 beyond x 460, so this corner is the one piece of clear space up there.

// `solveu-wordmark.png` is the portal's own SOLVE-U mark recoloured dark: the
// shipped `solve_logo.png` is near-white for the portal's dark theme and is
// invisible on the certificate's paper. Same letterforms, same alpha.
try {
  const png   = await doc.embedPng(fs.readFileSync(path.join(ROOT, 'assets', 'solveu-wordmark.png')));
  const logoW = 116;
  const logoH = (png.height / png.width) * logoW;
  page.drawImage(png, { x: 72, y: 500, width: logoW, height: logoH });
} catch {
  tracked('SOLVE-U', bold, 16, 504, 3, INK, 130);
}

// ── Title ────────────────────────────────────────────────────

const AXIS = W / 2;

tracked('CERTIFICATE', bold, 40, 428, 7, INK, AXIS);
tracked('OF COMPLETION', semi, 13, 398, 4.4, GREEN, AXIS);

// ── Recipient ────────────────────────────────────────────────

tracked('PROUDLY PRESENTED TO', semi, 10, 352, 2.6, INK, AXIS);

const form = doc.getForm();

const nameField = form.createTextField('name');
nameField.addToPage(page, {
  x: AXIS - 290, y: 280, width: 580, height: 54, borderWidth: 0, backgroundColor: undefined,
});
nameField.setAlignment(1);
nameField.setFontSize(40);

hline(AXIS - 250, AXIS + 250, 276);

// ── Training ─────────────────────────────────────────────────

centreAt('has successfully completed all requirements for', regular, 11, 248, BODY, AXIS);

const trainingField = form.createTextField('training');
trainingField.addToPage(page, {
  x: AXIS - 270, y: 206, width: 540, height: 30, borderWidth: 0, backgroundColor: undefined,
});
trainingField.setAlignment(1);
trainingField.setFontSize(17);

centreAt('issued by Solve University', regular, 11, 184, BODY, AXIS);

// ── Foot ─────────────────────────────────────────────────────
// Kept above y ≈ 100: the plate's bottom-left wedge reaches (394, 0) to (0, 68),
// and a field's own background over it would be very visible.

const FOOT_Y = 122;
const HALF   = 92;
const DATE_X = 262;
const SIG_X  = W - 262;

const dateField = form.createTextField('date');
dateField.addToPage(page, {
  x: DATE_X - HALF, y: FOOT_Y + 7, width: HALF * 2, height: 22,
  borderWidth: 0, backgroundColor: undefined,
});
dateField.setAlignment(1);
dateField.setFontSize(12);

hline(DATE_X - HALF, DATE_X + HALF, FOOT_Y);
tracked('DATE', semi, 8.5, FOOT_Y - 17, 2.4, INK, DATE_X);

// The space above this rule is deliberately empty — it is where a signature goes.
hline(SIG_X - HALF, SIG_X + HALF, FOOT_Y);
tracked('KANE HAMMONTREE, CEO', semi, 8.5, FOOT_Y - 17, 2.4, INK, SIG_X);

for (const f of [nameField, trainingField, dateField]) transparent(f);

// ── Field typography ─────────────────────────────────────────
// This, not the `font` option on addToPage, is what sets the font the fields
// render in. The name is script; the other two are not, so they are repointed
// afterwards — and setFontSize has to run again, because rewriting a field's
// default appearance also rewrites the size baked into it.
form.updateFieldAppearances(script);

trainingField.updateAppearances(semi);
trainingField.setFontSize(17);
dateField.updateAppearances(regular);
dateField.setFontSize(12);

// ── Save ─────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, await doc.save());
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`✔ certificate template → ${out} (${kb} KB)`);
