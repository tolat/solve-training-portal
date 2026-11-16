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
 * DESIGN: this follows the training portal's own light theme rather than
 * inventing a look. Everything below is lifted from css/styles.css
 * `body.logged-in`: the green, the near-black green text, the page tint, the
 * hairline borders, the rounded white card. The portal is sans-serif, so this
 * is Inter — the closest open face to its `-apple-system` stack. No gold, no
 * serif, no seal: none of those appear anywhere in the product.
 *
 * Two font traps, both silent, both found the hard way:
 *
 *   1. **The field font must not be subsetted.** A subset only contains the
 *      glyphs drawn at build time, so the first person called Renée or Muñoz
 *      would get a certificate with holes in their name.
 *   2. **`addToPage({font})` does not set a field's font.** It has to be
 *      `form.updateFieldAppearances(font)` before save, or every field falls
 *      back to Helvetica no matter what was passed in. `certificates.js` then
 *      has to re-apply it before flattening, for the same reason.
 *
 * A third: subsetting mangles the Inter TTFs Google's CSS API serves — most
 * glyphs vanish. Inter is embedded whole here, which is required anyway by (1).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.join(HERE, '..');
const FONTS = path.join(ROOT, 'assets', 'fonts');

// ── Palette — css/styles.css, body.logged-in ─────────────────
const hex = h => rgb(
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
);

const GREEN      = hex('#2a9640');  // --green
const GREEN_MID  = hex('#217832');  // --green-mid
const TEXT       = hex('#152219');  // --text
const PAGE_BG    = hex('#f2f5f2');  // --page-bg
const WHITE      = hex('#ffffff');  // --white
const GRAY       = rgb(0.48, 0.48, 0.48);              // --gray, rgba(0,0,0,0.48)
const BORDER     = rgb(0.90, 0.90, 0.90);              // --border, rgba(0,0,0,0.1)
const GREEN_WASH = rgb(0.937, 0.961, 0.941);           // --green-light over white

const W = 842; // A4 landscape, points
const H = 595;

const out = process.argv[2] || path.join(ROOT, 'assets', 'certificate-template.pdf');

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
doc.setTitle('Solve Energy — Certificate of Completion');
doc.setCreator('Solve Energy');
doc.setProducer('Solve University');

const read = f => fs.readFileSync(path.join(FONTS, f));
// Both embedded whole: SemiBold renders the name and training fields, which
// hold text nobody has typed yet; and subsetting corrupts these TTFs anyway.
const semi    = await doc.embedFont(read('Inter-SemiBold.ttf'), { subset: false });
const regular = await doc.embedFont(read('Inter-Regular.ttf'),  { subset: false });

const page = doc.addPage([W, H]);

// ── Helpers ──────────────────────────────────────────────────

const centre = (text, font, size, y, color = TEXT) => {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: (W - w) / 2, y, size, font, color });
};

/** Letterspaced text. pdf-lib has no tracking, so draw per glyph. */
const tracked = (text, font, size, y, tracking, color = TEXT, cx = W / 2) => {
  const chars = [...text];
  const total = chars.reduce((sum, c) => sum + font.widthOfTextAtSize(c, size) + tracking, 0) - tracking;
  let x = cx - total / 2;
  for (const c of chars) {
    page.drawText(c, { x, y, size, font, color });
    x += font.widthOfTextAtSize(c, size) + tracking;
  }
};

/**
 * Rounded rectangle — pdf-lib's drawRectangle has no corner radius.
 *
 * Takes ordinary PDF coordinates (origin bottom-left, y up) like every other
 * call on this page. drawSvgPath's y axis runs DOWNWARD from the origin it is
 * given, so the conversion happens here, once, instead of at every call site —
 * getting that wrong silently put the training chip 200pt up the page, on top
 * of a label.
 */
const roundedRect = ({ x, y, width, height, r, color, borderColor, borderWidth = 0 }) => {
  const top = H - (y + height);   // distance from the top edge to the rect's top
  const p = [
    `M ${x + r} ${top}`,
    `H ${x + width - r}`, `Q ${x + width} ${top} ${x + width} ${top + r}`,
    `V ${top + height - r}`, `Q ${x + width} ${top + height} ${x + width - r} ${top + height}`,
    `H ${x + r}`, `Q ${x} ${top + height} ${x} ${top + height - r}`,
    `V ${top + r}`, `Q ${x} ${top} ${x + r} ${top}`,
    'Z',
  ].join(' ');
  page.drawSvgPath(p, { x: 0, y: H, color, borderColor, borderWidth, scale: 1 });
};

const hline = (x1, x2, y, color = BORDER, thickness = 1) =>
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });

// ── Page ─────────────────────────────────────────────────────
// The portal is a white card floating on a faintly green page.

page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: PAGE_BG });

const M = 26;                      // page margin
const R = 14;                      // card corner radius, as the portal's cards

roundedRect({
  x: M, y: M, width: W - M * 2, height: H - M * 2, r: R,
  color: WHITE, borderColor: BORDER, borderWidth: 1,
});

// Green keyline across the top of the card, inset past the corner radius so it
// does not poke square ends out of the rounded corners.
page.drawRectangle({ x: M + R, y: H - M - 5, width: W - (M + R) * 2, height: 4, color: GREEN });

// ── Wordmark ─────────────────────────────────────────────────

try {
  const png   = await doc.embedPng(fs.readFileSync(path.join(ROOT, 'assets', 'solve-wordmark.png')));
  const logoW = 112;
  const logoH = (png.height / png.width) * logoW;
  page.drawImage(png, { x: (W - logoW) / 2, y: 470, width: logoW, height: logoH });
} catch {
  tracked('SOLVE', semi, 17, 474, 3, TEXT);
}

tracked('SOLVE UNIVERSITY', regular, 7.5, 456, 2.6, GRAY);

// ── Title ────────────────────────────────────────────────────

centre('Certificate of Completion', semi, 26, 402, TEXT);
hline(W / 2 - 24, W / 2 + 24, 384, GREEN, 2.5);   // the portal's accent, not an ornament

// ── Recipient ────────────────────────────────────────────────

tracked('THIS IS TO CERTIFY THAT', regular, 8, 356, 2.2, GRAY);

const form = doc.getForm();

const nameField = form.createTextField('name');
nameField.addToPage(page, {
  x: 100, y: 300, width: W - 200, height: 42, borderWidth: 0, backgroundColor: WHITE,
});
nameField.setAlignment(1);
nameField.setFontSize(30);

hline(W / 2 - 250, W / 2 + 250, 294, BORDER);

// ── Training, in a soft card like the portal's module rows ───

tracked('HAS SUCCESSFULLY COMPLETED', regular, 8, 268, 2.2, GRAY);

const CHIP = { w: 460, h: 46, y: 206 };
roundedRect({
  x: (W - CHIP.w) / 2, y: CHIP.y, width: CHIP.w, height: CHIP.h, r: 10,
  color: GREEN_WASH, borderColor: BORDER, borderWidth: 0.8,
});

const trainingField = form.createTextField('training');
trainingField.addToPage(page, {
  x: (W - CHIP.w) / 2 + 12, y: CHIP.y + 8, width: CHIP.w - 24, height: 30, borderWidth: 0,
  // A text field paints its own background — white by default, which would
  // punch a white slab through the chip it sits on.
  backgroundColor: GREEN_WASH,
});
trainingField.setAlignment(1);
trainingField.setFontSize(16);

// ── Foot: CEO signature left, date right ─────────────────────

const FOOT_Y = 126;    // the rule both blocks sit on
const OFFSET = 180;
const SIG_X  = W / 2 - OFFSET;
const DATE_X = W / 2 + OFFSET;
const HALF   = 118;

// Signature block. The space above the rule is deliberately empty: it is where
// a signature goes, whether wet-signed on a print or dropped in as an image.
hline(SIG_X - HALF, SIG_X + HALF, FOOT_Y, BORDER);
centreAt('Kane Hammontree, CEO', semi, 10.5, FOOT_Y - 19, TEXT, SIG_X);

// Date block — one line under the rule on this side too, so the foot is even.
hline(DATE_X - HALF, DATE_X + HALF, FOOT_Y, BORDER);
tracked('DATE COMPLETED', regular, 7, FOOT_Y - 18, 2.2, GRAY, DATE_X);

const dateField = form.createTextField('date');
dateField.addToPage(page, {
  x: DATE_X - HALF, y: FOOT_Y + 7, width: HALF * 2, height: 22, borderWidth: 0,
  backgroundColor: WHITE,
});
dateField.setAlignment(1);
dateField.setFontSize(13);

// ── Footer line ──────────────────────────────────────────────

tracked('ISSUED BY SOLVE ENERGY', regular, 6.5, 54, 2.4, GRAY);

// ── Field typography ─────────────────────────────────────────
// This, not the `font` option on addToPage, is what actually sets the font the
// fields render in. Without it all three fall back to Helvetica.
form.updateFieldAppearances(semi);

// ── Save ─────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, await doc.save());
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`✔ certificate template → ${out} (${kb} KB)`);

/** Centre text on an arbitrary x, not the page centre. */
function centreAt(text, font, size, y, color, cx) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: cx - w / 2, y, size, font, color });
}
