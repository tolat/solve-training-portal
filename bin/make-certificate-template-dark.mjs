#!/usr/bin/env node
/**
 * Turn the supplied dark SOLVE-U plate into a fillable certificate template.
 *
 *   node bin/make-certificate-template-dark.mjs
 *   assets/certificate-dark-base.pdf  ->  assets/certificate-template-dark.pdf
 *
 * Unlike `make-certificate-template.mjs`, which draws its whole certificate,
 * this one only adds form fields: the artwork, the wording and the rules are
 * all in the supplied PDF and are left untouched. Nothing is drawn on the page.
 *
 * ── The plate ──────────────────────────────────────────────────────────────
 *
 * US Letter landscape, 792 x 612 pt — NOT the A4 landscape (842 x 595) the
 * light template uses, so none of its coordinates carry over.
 *
 * Every number below was measured off a 150 dpi render by scanning for the
 * plate's own horizontal rules and text bands, not read off a grid by eye:
 *
 *   | feature            | y (pt, from the bottom) | x span (pt)    |
 *   |--------------------|-------------------------|----------------|
 *   | NAME rule          | 258.7                   | 72.5 - 523.2   |
 *   | "Presented to"     | 308.6 - 317.8           |                |
 *   | PROGRAMME rule     | 172.3                   | 72.5 - 523.2   |
 *   | "has successfully completed all requirements for" | 208.8 - 220.3 | |
 *   | foot rules (x3)    | 109.6                   | 72.5 - 211.2, 240.5 - 379.2, 408.5 - 547.2 |
 *   | DATE / SIGNED / CERTIFICATE No. labels | 98.9 - 102.7 |        |
 *
 * Each field sits in the clear space *above* its rule. The middle foot rule is
 * deliberately left empty: it is the signature line, with KANE HAMMONTREE, CEO
 * already printed beneath it.
 *
 * ── The traps ──────────────────────────────────────────────────────────────
 *
 * 1. **The plate is dark, so the fields must carry their own colour.** pdf-lib
 *    defaults a field's text to black, which on this background is invisible —
 *    the certificate would come out looking blank. The colour is read back out
 *    of each field's /DA string by pdf-lib's appearance provider
 *    (`getDefaultColor`), and `certificates.js` calls `updateAppearances(font)`
 *    at issuance, which preserves whatever colour it finds there. So stamping
 *    the colour into the DA here is what survives all the way to the issued
 *    PDF. `setFontSize` splices only the Tf operator and leaves the colour
 *    alone, so the two do not fight.
 *
 *    The colours are sampled from the plate's own ink rather than invented, so
 *    a filled certificate matches the design that was handed over.
 *
 * 2. **A text field paints its own background, white by default.** On a dark
 *    plate that is a glaring slab. `backgroundColor: undefined` is not enough —
 *    the widget still carries an /MK dictionary — so it is deleted outright.
 *
 * 3. **The name and programme fields auto-size; the date and serial do not.**
 *    Neither length is known here — a certificate title is a pattern
 *    ("[Role] Certification") and names run long — and at a fixed size pdf-lib
 *    clips rather than shrinks, so "Christopher Alexander Rodriguez-Fernandez"
 *    lost its last letter off the end of the rule. Font size 0 makes pdf-lib
 *    fit the text to the box, and because it fits the box *height* as well as
 *    its width, a short value cannot balloon to fill the width: the box height
 *    is what caps it (38 pt box -> about 28 pt of script, 20 pt box -> about
 *    15 pt of Inter). The date and the serial are both fixed-length, so they
 *    are set outright.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, rgb } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src  = path.join(ROOT, 'assets', 'certificate-dark-base.pdf');
const out  = path.join(ROOT, 'assets', 'certificate-template-dark.pdf');

const doc = await PDFDocument.load(fs.readFileSync(src));

const page = doc.getPage(0);
const { width: W, height: H } = page.getSize();
if (Math.round(W) !== 792 || Math.round(H) !== 612) {
  console.warn(`⚠️  plate is ${W} x ${H}, not the 792 x 612 these coordinates were measured on`);
}

// ── Measured geometry ────────────────────────────────────────

const LEFT       = 72.5;          // every rule starts here
const LONG_W     = 450.7;         // name and programme rules
const SHORT_W    = 138.7;         // the three foot rules
const CERTNO_X   = 408.5;         // third foot rule
const NAME_RULE  = 258.7;
const PROG_RULE  = 172.3;
const FOOT_RULE  = 109.6;

// ── The plate's own ink, sampled from a 150 dpi render ───────

const BODY   = rgb(0.934, 0.947, 0.900);   // "has successfully completed all requirements for"
const FOOT   = rgb(0.893, 0.907, 0.848);   // "KANE HAMMONTREE, CEO"

// ── Fonts: deliberately none ─────────────────────────────────
//
// The fields keep pdf-lib's standard Helvetica in their /DA. Nothing renders
// in it: `certificates.js` embeds the real faces itself at issuance, calls
// `updateAppearances(font)` on every field and then flattens, so the only
// thing the template's /DA contributes to the finished certificate is the
// SIZE and the COLOUR.
//
// Embedding Allura and Inter here as well cost ~420 KB in the template and
// every certificate made from it — carried along by pdf-lib's object copy and
// never drawn with, on top of the subsets issuance adds. Dropping them took an
// issued certificate from 1.25 MB to ~300 KB, which matters because the whole
// file is downloaded for each thumbnail on the main page.
//
// The trade: open the template itself and the empty fields read as Helvetica.
// It is an internal artefact that only ever gets filled through the pipeline.

const form = doc.getForm();

/**
 * Remove a field's background entirely. Passing `backgroundColor: undefined`
 * stops pdf-lib writing /BG, but the widget keeps its /MK dictionary; dropping
 * that is what guarantees nothing is painted behind the value.
 */
const transparent = field => {
  for (const widget of field.acroField.getWidgets()) widget.dict.delete(PDFName.of('MK'));
};

/**
 * Stamp a colour into the field's default appearance, keeping its /Tf operator.
 * This is the only place the issued certificate's text colour comes from.
 */
const colour = (field, c) => {
  const da = field.acroField.getDefaultAppearance() ?? '';
  const tf = da.match(/\/[^\s]+\s+[\d.]+\s+Tf/)?.[0];
  if (!tf) throw new Error(`field "${field.getName()}" has no /Tf operator to keep`);
  const { red, green, blue } = c;
  field.acroField.setDefaultAppearance(`${red} ${green} ${blue} rg ${tf}`);
};

const field = (name, { x, y, width, height, size, color }) => {
  const f = form.createTextField(name);
  f.addToPage(page, { x, y, width, height, borderWidth: 0, backgroundColor: undefined });
  f.setAlignment(0);                 // left, matching the labels under each rule
  transparent(f);
  f.setFontSize(size);               // size first...
  colour(f, color);                  // ...then the colour, which keeps the /Tf
  return f;
};

// ── The fields ───────────────────────────────────────────────

// Size 0 = fit to the box, for both of these. See trap 3.
field('name', {
  x: LEFT, y: NAME_RULE + 4, width: LONG_W, height: 38,
  size: 0, color: BODY,
});

field('training', {
  x: LEFT, y: PROG_RULE + 2, width: LONG_W, height: 20,
  size: 0, color: BODY,
});

field('date', {
  x: LEFT, y: FOOT_RULE + 2.5, width: SHORT_W, height: 18,
  size: 10.5, color: FOOT,
});

// The middle foot rule is the signature line and is left alone.

field('certificate_no', {
  x: CERTNO_X, y: FOOT_RULE + 2.5, width: SHORT_W, height: 18,
  size: 10.5, color: FOOT,
});

// ── Save ─────────────────────────────────────────────────────
//
// 🔴 `save()` runs `form.updateFieldAppearances()` unless told not to, and that
// RESOLVES an auto-size: a field left at `0 Tf` is measured against its empty
// value and written back as a concrete size. The template then ships with that
// size fixed, auto-sizing silently gone, and the first long name is clipped at
// the end of the rule instead of shrinking to fit — which is exactly what
// happened here (0 Tf became 32 Tf, and "Christopher Alexander
// Rodriguez-Fernandez" lost its last four letters).

fs.writeFileSync(out, await doc.save({ updateFieldAppearances: false }));
console.log(`✔  ${path.relative(ROOT, out)}  —  ${form.getFields().map(f => f.getName()).join(', ')}`);
