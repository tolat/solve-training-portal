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
 * ── The corner ribbons ───────────────────────────────────────
 *
 * The first two attempts drew the bands as nested arcs sharing a corner, each
 * band's inner edge being the next one's outer edge. That constraint makes
 * concentric rings by construction — no amount of tuning the curve shape gets
 * you a ribbon out of it, which is exactly how it looked.
 *
 * So: each ribbon here is an INDEPENDENT shape with its own centreline and its
 * own width along that line. They are free to cross each other, which is what
 * the reference actually does, and they swell and taper instead of running at
 * a constant width.
 *
 * A ribbon's outline is built by walking its centreline, taking the normal at
 * each step and offsetting both ways by half the width there. Sampled finely
 * enough it is indistinguishable from a true offset curve.
 *
 * Everything is in svgPath's space: origin top-left, y downward.
 */

const bez = (a, b, c, d, t) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};
const bezDeriv = (a, b, c, d, t) => {
  const u = 1 - t;
  return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c);
};

/**
 * @param {number[][]} cp  four control points [[x,y],...]
 * @param {(t:number)=>number} widthAt  ribbon width at t, in points
 */
function ribbon(cp, widthAt, samples = 72) {
  const [P0, P1, P2, P3] = cp;
  const left = [], right = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const x  = bez(P0[0], P1[0], P2[0], P3[0], t);
    const y  = bez(P0[1], P1[1], P2[1], P3[1], t);
    const dx = bezDeriv(P0[0], P1[0], P2[0], P3[0], t);
    const dy = bezDeriv(P0[1], P1[1], P2[1], P3[1], t);
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;      // unit normal
    const h = widthAt(t) / 2;
    left.push([x + nx * h, y + ny * h]);
    right.push([x - nx * h, y - ny * h]);
  }
  const pts = [...left, ...right.reverse()];
  return 'M ' + pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ') + ' Z';
}

/** A ribbon centreline from the top edge to the right edge. */
const line = (x, y, { lazy = 0.05, bend = 0.56, late = 0.68 } = {}) => [
  [x, 0],
  [x + lazy * (W - x), bend * y],
  [x + late * (W - x), y],
  [W, y],
];

/** Fattest in the middle, never pinching to nothing at the page edges. */
const swell = (max, ends = 0.55) => t => max * (ends + (1 - ends) * Math.sin(Math.PI * t));
/** Full width at the start, tapering to a point — a ribbon end inside the page. */
const taperOut = max => t => max * Math.max(0.02, 1 - Math.pow(t, 1.6));

/** The solid corner: everything between a curve and the corner itself. */
function cornerFill(x, y, opts) {
  const [, c1, c2, p3] = line(x, y, opts);
  return `M ${x} 0 C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p3[0]} ${p3[1]} L ${W} 0 Z`;
}

const rot = ([x, y]) => [W - x, H - y];
const rotPath = d => d.replace(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g,
  (_, a, b) => { const [x, y] = rot([parseFloat(a), parseFloat(b)]); return `${x.toFixed(2)} ${y.toFixed(2)}`; });

// ── Page and ribbons ─────────────────────────────────────────

page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: WHITE });

/**
 * The corner composition, drawn back to front. The `late` values differ on
 * purpose: ribbons that turn into the right edge at different points cross
 * each other instead of nesting, which is the whole difference between a
 * ribbon and a stripe.
 */
function cornerArt(scale = 1) {
  const sx = x => W - (W - x) * scale;     // pull entry points toward the corner
  const sy = y => y * scale;
  const sw = w => w * scale;
  const out = [];

  // The solid mass filling the corner
  out.push([cornerFill(sx(470), sy(300), { lazy: 0.02, bend: 0.58, late: 0.74 }), GREEN_DEEP]);

  // A bright green ribbon cutting across it, turning early so it crosses
  out.push([ribbon(line(sx(505), sy(232), { lazy: 0.04, bend: 0.54, late: 0.64 }),
                   swell(sw(62))), GREEN]);

  // Gold, turning late — crosses the green twice
  out.push([ribbon(line(sx(556), sy(206), { lazy: 0.03, bend: 0.60, late: 0.77 }),
                   swell(sw(26), 0.4)), GOLD]);

  // A second, thinner gold inboard of it
  out.push([ribbon(line(sx(648), sy(140), { lazy: 0.05, bend: 0.54, late: 0.66 }),
                   swell(sw(13), 0.35)), GOLD_LIGHT]);

  // Mid green closing the inner edge, tapering to a point on the page
  out.push([ribbon(line(sx(690), sy(104), { lazy: 0.05, bend: 0.58, late: 0.72 }),
                   taperOut(sw(52))), GREEN_MID]);

  return out;
}

for (const [d, color] of cornerArt(0.76))  svgPath(d, { color });
for (const [d, color] of cornerArt(0.66))  svgPath(rotPath(d), { color });

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
