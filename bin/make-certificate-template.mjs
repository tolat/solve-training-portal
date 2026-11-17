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
 * DESIGN: a classic award certificate — sweeping ribbons in the top-right and
 * bottom-left corners, a thin double frame, a heavy title and the recipient's
 * name in script. The greens are Solve's own (`css/styles.css`
 * `body.logged-in`), deepened for the ribbons so they read as layered rather
 * than flat. Gold is the one colour from outside the product palette, and it
 * is what makes this kind of certificate look like one.
 *
 * Font traps, all silent, all covered by test/certificates.test.js:
 *
 *   1. **The field fonts must not be subsetted.** A subset only contains the
 *      glyphs drawn at build time, so the first person called Renée or Muñoz
 *      would get holes punched through their own name.
 *   2. **`addToPage({font})` does not set a field's font.** It has to be
 *      `form.updateFieldAppearances(font)` before save, and `certificates.js`
 *      has to re-apply it before flattening, or everything falls back to
 *      Helvetica while the static title still looks right.
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

const GREEN      = hex('#2a9640');  // --green, the portal's own
const GREEN_MID  = hex('#217832');  // --green-mid
const GREEN_DEEP = hex('#13401f');  // deepened for the ribbons' shadow side
const INK        = hex('#152219');  // --text
const GOLD       = hex('#c9a349');
const GOLD_LIGHT = hex('#e7d6a3');
const GOLD_DEEP  = hex('#a8822f');
const GRAY       = rgb(0.46, 0.49, 0.47);
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
// Allura, not Great Vibes: Great Vibes renders a precomposed é with a broken
// advance in pdf-lib, so "Renée" comes out as "Ren ée". Verified by rendering
// both against the same string.
const script  = await doc.embedFont(read('Allura-Regular.ttf'), { subset: false });
const bold    = await doc.embedFont(read('Inter-Bold.ttf'),         { subset: false });
const semi    = await doc.embedFont(read('Inter-SemiBold.ttf'),     { subset: false });
const regular = await doc.embedFont(read('Inter-Regular.ttf'),      { subset: false });

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

/**
 * ── The corner swoops ────────────────────────────────────────
 *
 * Each ribbon edge is a cubic from a point on the top edge to a point on the
 * right edge, written in svgPath's space (origin top-left, y down).
 *
 * A quarter-ellipse — the obvious shape — bends evenly the whole way round and
 * reads as a rainbow stripe. The reference's ribbons do not: they leave the top
 * edge steeply, run almost straight across the diagonal, then turn hard into
 * the right edge. `lazy` and `late` are what buy that.
 *
 *   x, y   where the edge meets the top and right edges
 *   lazy   how far along the diagonal the first control point sits
 *          (small = leaves the top edge steeply, like the reference)
 *   bend   how far down the first control point pulls (big = flatter middle)
 *   late   where the second control point sits (big = turns into the right
 *          edge at the last moment, which is the "swoosh")
 */
const edge = ({ x, y, lazy = 0.10, bend = 0.80, late = 0.52 }) => ({
  p0: [x, 0],
  p1: [x + lazy * (W - x), bend * y],
  p2: [x + late * (W - x), y],
  p3: [W, y],
});

/** 180° rotation about the page centre: maps the top-right corner onto the bottom-left. */
const rot = ([x, y]) => [W - x, H - y];

/**
 * A band is the area between two edges. Giving the outer and inner edges
 * different entry points AND different curvature is what makes a band swell
 * and taper like a ribbon instead of sitting at a constant width.
 */
function swoop(outerSpec, innerSpec, { rotate = false } = {}) {
  const o = edge(outerSpec), i = edge(innerSpec);
  const t = rotate ? rot : (q => q);
  const [o0, o1, o2, o3] = [o.p0, o.p1, o.p2, o.p3].map(t);
  const [i0, i1, i2, i3] = [i.p0, i.p1, i.p2, i.p3].map(t);
  return [
    `M ${o0[0]} ${o0[1]}`,
    `C ${o1[0]} ${o1[1]} ${o2[0]} ${o2[1]} ${o3[0]} ${o3[1]}`,
    `L ${i3[0]} ${i3[1]}`,                                   // along the right edge
    `C ${i2[0]} ${i2[1]} ${i1[0]} ${i1[1]} ${i0[0]} ${i0[1]}`, // inner edge, reversed
    'Z',
  ].join(' ');
}

// ── Page and ribbons ─────────────────────────────────────────

page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: WHITE });

// Outermost first, so each band overlaps the one before it. Read the pairs as
// "outer edge, inner edge": the deep green mass fills the corner, gold threads
// through it, bright green sweeps across, a pale highlight catches the inner
// turn, and mid green closes it off.
const BANDS = [
  // A quarter arc is lazy 0, bend 0.55, late 0.55. Holding bend near that keeps
  // the ribbon hugging the corner instead of flooding the page; pushing `late`
  // to ~0.70 makes it run flat across the diagonal then turn hard into the
  // right edge — the swoosh.
  //
  // The bands are spread wider where they meet the top edge than where they
  // meet the right, so each one narrows along its length. That taper is what
  // reads as a ribbon; equal gaps at both ends read as a rainbow stripe.
  //
  // Each band's inner edge is the next band's outer edge, exactly — a mismatch
  // there opens a seam of whatever was drawn underneath.
  [{ x: 516, y: 246, lazy: 0.02, bend: 0.58, late: 0.72 },
   { x: 568, y: 200, lazy: 0.04, bend: 0.57, late: 0.70 }, GREEN_DEEP],

  [{ x: 568, y: 200, lazy: 0.04, bend: 0.57, late: 0.70 },
   { x: 590, y: 190, lazy: 0.05, bend: 0.56, late: 0.69 }, GOLD],

  [{ x: 590, y: 190, lazy: 0.05, bend: 0.56, late: 0.69 },
   { x: 650, y: 140, lazy: 0.07, bend: 0.55, late: 0.67 }, GREEN],

  [{ x: 650, y: 140, lazy: 0.07, bend: 0.55, late: 0.67 },
   { x: 664, y: 134, lazy: 0.08, bend: 0.55, late: 0.66 }, GOLD_LIGHT],

  [{ x: 664, y: 134, lazy: 0.08, bend: 0.55, late: 0.66 },
   { x: 726, y:  92, lazy: 0.10, bend: 0.54, late: 0.64 }, GREEN_MID],
];

for (const [o, i, color] of BANDS) svgPath(swoop(o, i), { color });

// The bottom-left corner is the same artwork rotated 180°, as on the reference,
// scaled in a little so the foot stays clear for the date and signature lines.
const SCALE = 0.88;
const scaled = spec => ({ ...spec, x: W - (W - spec.x) * SCALE, y: spec.y * SCALE });
for (const [o, i, color] of BANDS) svgPath(swoop(scaled(o), scaled(i), { rotate: true }), { color });

// ── Frame ────────────────────────────────────────────────────
// A thin double rule, as on the reference: it sits over the ribbons.

page.drawRectangle({
  x: 24, y: 24, width: W - 48, height: H - 48,
  borderColor: GOLD, borderWidth: 1.1,
});
page.drawRectangle({
  x: 30, y: 30, width: W - 60, height: H - 60,
  borderColor: GOLD_LIGHT, borderWidth: 0.6,
});

// ── Wordmark ─────────────────────────────────────────────────

try {
  const png   = await doc.embedPng(fs.readFileSync(path.join(ROOT, 'assets', 'solve-wordmark.png')));
  const logoW = 104;
  const logoH = (png.height / png.width) * logoW;
  page.drawImage(png, { x: 92, y: 492, width: logoW, height: logoH });
} catch {
  tracked('SOLVE', bold, 16, 496, 3, INK, 144);
}

// ── Title ────────────────────────────────────────────────────

const AXIS = 400;   // content centres left of the page centre, clear of the ribbon

tracked('CERTIFICATE', bold, 41, 418, 3.5, GREEN_DEEP, AXIS);
tracked('OF COMPLETION', semi, 14.5, 390, 5.5, GOLD_DEEP, AXIS);

// ── Recipient ────────────────────────────────────────────────

tracked('THIS CERTIFICATE IS PRESENTED TO', semi, 9.5, 348, 2.2, INK, AXIS);

const form = doc.getForm();

const nameField = form.createTextField('name');
nameField.addToPage(page, {
  x: AXIS - 280, y: 268, width: 560, height: 56, borderWidth: 0, backgroundColor: WHITE,
});
nameField.setAlignment(1);
nameField.setFontSize(42);

hline(AXIS - 240, AXIS + 240, 264, GREEN_MID, 1);

// ── Training ─────────────────────────────────────────────────

tracked('HAS SUCCESSFULLY COMPLETED', regular, 8.5, 230, 2.2, GRAY, AXIS);

const trainingField = form.createTextField('training');
trainingField.addToPage(page, {
  // Starts at x=200: a field paints its own white background, and at this
  // height the bottom-left ribbon reaches x=173.
  x: 200, y: 192, width: 400, height: 30, borderWidth: 0, backgroundColor: WHITE,
});
trainingField.setAlignment(1);
trainingField.setFontSize(16);

// ── Foot: date and signature, clear of the bottom-left ribbon ─

const FOOT_Y = 112;
const HALF   = 92;
const DATE_X = 452;
const SIG_X  = 672;

const dateField = form.createTextField('date');
dateField.addToPage(page, {
  x: DATE_X - HALF, y: FOOT_Y + 7, width: HALF * 2, height: 22,
  borderWidth: 0, backgroundColor: WHITE,
});
dateField.setAlignment(1);
dateField.setFontSize(12.5);

hline(DATE_X - HALF, DATE_X + HALF, FOOT_Y, GREEN_DEEP, 1.2);
tracked('DATE', semi, 8.5, FOOT_Y - 17, 2.2, INK, DATE_X);

// Signature — the space above the rule is deliberately empty, for a signature
hline(SIG_X - HALF, SIG_X + HALF, FOOT_Y, GREEN_DEEP, 1.2);
centreAt('Kane Hammontree, CEO', semi, 9.5, FOOT_Y - 17, INK, SIG_X);
tracked('SIGNATURE', regular, 7, FOOT_Y - 31, 2, GRAY, SIG_X);

// ── Field typography ─────────────────────────────────────────
// This, not the `font` option on addToPage, is what sets the font the fields
// render in. The name is script; the other two are not, so they are repointed
// afterwards — and setFontSize has to run again, because rewriting a field's
// default appearance also rewrites the size baked into it.
form.updateFieldAppearances(script);

trainingField.updateAppearances(semi);
trainingField.setFontSize(16);
dateField.updateAppearances(regular);
dateField.setFontSize(12.5);

// ── Save ─────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, await doc.save());
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`✔ certificate template → ${out} (${kb} KB)`);
