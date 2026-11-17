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
 * DESIGN: built to a reference Torin supplied — angled corner wedges top-right
 * and bottom-left with gold stripes running parallel, a thin gold frame, a
 * faint guilloche ground, a large letterspaced title and the recipient's name
 * in script. The reference's navy is replaced by Solve's green throughout
 * (`css/styles.css` `body.logged-in`), and the type is Inter, Solve's own face.
 * Gold is kept: it is structural to the reference and carries the whole look.
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
 *   3. **A text field paints its own background**, white by default.
 *   4. **`drawSvgPath`'s y axis runs downward** from the origin it is given,
 *      unlike every other call here. `svgPath()` converts once, internally.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.join(HERE, '..');
const FONTS = path.join(ROOT, 'assets', 'fonts');

// ── Palette ──────────────────────────────────────────────────
const hex = h => rgb(
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
);

// The reference's navy, replaced by Solve's green at the same two depths.
const GREEN_DEEP = hex('#134a26');
const GREEN      = hex('#2a9640');  // --green
const GOLD       = hex('#c8a24a');
const GOLD_LIGHT = hex('#e8d7a4');
const GOLD_DEEP  = hex('#a07c2c');
const INK        = hex('#111111');
const BODY       = hex('#333333');
const GRAY       = rgb(0.42, 0.42, 0.42);
const GUILLOCHE  = rgb(0.945, 0.952, 0.945);
const WHITE      = rgb(1, 1, 1);

const W = 842; // A4 landscape, points
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

const hline = (x1, x2, y, color, thickness = 1) =>
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });

/**
 * Draw an SVG path. drawSvgPath's y runs DOWNWARD from its origin, so every
 * path below is written in that space and the origin is pinned to the top-left
 * of the page here — converting once rather than at each call site.
 */
const svgPath = (d, opts) => page.drawSvgPath(d, { x: 0, y: H, ...opts });

const poly = pts => 'M ' + pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ') + ' Z';

// ── Corner wedges ────────────────────────────────────────────
//
// The reference's corners are straight-edged, not curved: a filled wedge cut
// off by one diagonal, with gold stripes running parallel to it. Each stripe is
// the diagonal offset along its own normal, extended well past both ends so it
// runs off the page rather than stopping short — anything outside the page box
// is clipped on render.

/** The diagonal: meets the top edge at xTop and the right edge at yRight. */
const A = [560, 0];
const B = [W, 96];

const dir = [B[0] - A[0], B[1] - A[1]];
const dlen = Math.hypot(dir[0], dir[1]);
const u = [dir[0] / dlen, dir[1] / dlen];       // along the diagonal
const n = [-u[1], u[0]];                        // normal, pointing into the page

const EXT = 420;                                // overshoot past both ends
const at = (p, alongFrom, off) => [
  p[0] + u[0] * alongFrom + n[0] * off,
  p[1] + u[1] * alongFrom + n[1] * off,
];

/** A stripe parallel to the diagonal: `off` from it, `t` thick. */
const stripe = (off, t) => poly([
  at(A, -EXT, off), at(B, EXT, off), at(B, EXT, off + t), at(A, -EXT, off + t),
]);

/** The filled corner: everything on the far side of the diagonal. */
const wedge = off => poly([
  at(A, -EXT, off), at(B, EXT, off), [W + EXT, -EXT], [A[0] - EXT, -EXT],
]);

const rot = ([x, y]) => [W - x, H - y];
const rotPath = d => d.replace(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g,
  (_, a, b) => { const [x, y] = rot([parseFloat(a), parseFloat(b)]); return `${x.toFixed(2)} ${y.toFixed(2)}`; });

/** One corner's artwork, outermost first. */
const cornerArt = () => [
  [wedge(0),           GREEN_DEEP],   // the mass filling the corner
  [stripe(0, 5),       GOLD],         // gold edging the wedge
  [stripe(5, 26),      GREEN],        // the lighter green band
  [stripe(31, 7),      GOLD],         // thick gold stripe
  [stripe(46, 2.2),    GOLD_LIGHT],   // thin gold line, set off in the white
];

// ── Page ─────────────────────────────────────────────────────

page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: WHITE });

// Guilloche: a faint lattice of long sine waves, as on the reference. Kept very
// close to white — it should read as texture, never as lines.
for (let i = 0; i < 34; i++) {
  const baseY = 74 + i * 14;
  const amp   = 26 + (i % 3) * 10;
  const wav   = 460 + (i % 4) * 110;   // long and lazy, so it reads as moiré
  const pts = [];
  for (let x = 36; x <= W - 36; x += 8) {
    pts.push(`${x} ${(baseY + Math.sin((x + i * 46) / wav * Math.PI * 2) * amp).toFixed(2)}`);
  }
  svgPath('M ' + pts.join(' L '), { borderColor: GUILLOCHE, borderWidth: 0.35 });
}

// ── Frame ────────────────────────────────────────────────────

page.drawRectangle({
  x: 26, y: 26, width: W - 52, height: H - 52,
  borderColor: GOLD, borderWidth: 1.4,
});

// ── Corners ──────────────────────────────────────────────────
// Drawn after the frame so the wedges sit over it, as on the reference.

for (const [d, color] of cornerArt()) svgPath(d, { color });
for (const [d, color] of cornerArt()) svgPath(rotPath(d), { color });

// ── Wordmark ─────────────────────────────────────────────────

try {
  const png   = await doc.embedPng(fs.readFileSync(path.join(ROOT, 'assets', 'solve-wordmark.png')));
  const logoW = 104;
  const logoH = (png.height / png.width) * logoW;
  page.drawImage(png, { x: 70, y: 492, width: logoW, height: logoH });
} catch {
  tracked('SOLVE', bold, 16, 496, 3, INK, 122);
}

// ── Title ────────────────────────────────────────────────────

tracked('CERTIFICATE', bold, 42, 410, 7, INK);
tracked('OF COMPLETION', semi, 13, 378, 4.2, INK);

// ── Recipient ────────────────────────────────────────────────

tracked('PROUDLY PRESENTED TO', semi, 10.5, 318, 2.6, INK);

const form = doc.getForm();

const nameField = form.createTextField('name');
nameField.addToPage(page, {
  x: 160, y: 236, width: W - 320, height: 54, borderWidth: 0, backgroundColor: WHITE,
});
nameField.setAlignment(1);
nameField.setFontSize(40);

hline(150, W - 150, 232, rgb(0.35, 0.35, 0.35), 0.9);

// ── Training ─────────────────────────────────────────────────

centreAt('has successfully completed all requirements of', regular, 11, 204, BODY);

const trainingField = form.createTextField('training');
trainingField.addToPage(page, {
  x: 150, y: 164, width: W - 300, height: 30, borderWidth: 0, backgroundColor: WHITE,
});
trainingField.setAlignment(1);
trainingField.setFontSize(17);

centreAt('issued by Solve University', regular, 11, 142, BODY);

// ── Foot: date left, signature right ─────────────────────────

// The bottom-left wedge reaches roughly y = 60 at this x, so the foot sits
// above it — a date field paints its own white background and a white slab
// across the wedge is very visible.
const FOOT_Y = 94;
const HALF   = 86;
const DATE_X = 252;
const SIG_X  = W - 252;

const dateField = form.createTextField('date');
dateField.addToPage(page, {
  x: DATE_X - HALF, y: FOOT_Y + 6, width: HALF * 2, height: 22,
  borderWidth: 0, backgroundColor: WHITE,
});
dateField.setAlignment(1);
dateField.setFontSize(12);

hline(DATE_X - HALF, DATE_X + HALF, FOOT_Y, rgb(0.35, 0.35, 0.35), 0.9);
tracked('DATE', semi, 8.5, FOOT_Y - 17, 2.4, INK, DATE_X);

// The space above this rule is deliberately empty — it is where a signature goes.
hline(SIG_X - HALF, SIG_X + HALF, FOOT_Y, rgb(0.35, 0.35, 0.35), 0.9);
tracked('KANE HAMMONTREE, CEO', semi, 8.5, FOOT_Y - 17, 2.4, INK, SIG_X);

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
