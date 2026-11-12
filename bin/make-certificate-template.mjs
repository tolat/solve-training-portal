/**
 * Build the default Solve completion-certificate template.
 *
 *   node bin/make-certificate-template.mjs [out.pdf]
 *
 * Produces an A4-landscape PDF with two AcroForm text fields, `name` and
 * `date`, which is what `certificates.js` fills. Keeping the template as a
 * generated file rather than a binary in the repo means the wording, colours
 * and layout are reviewable in a diff.
 *
 * To use a designer's artwork instead, hand them this spec: any PDF with text
 * fields named `name` and `date` works, and a PDF with no fields at all still
 * works — the portal centres the name and date on page one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const GREEN      = rgb(0x2a / 255, 0x96 / 255, 0x40 / 255);
const GREEN_DARK = rgb(0x21 / 255, 0x78 / 255, 0x32 / 255);
const INK        = rgb(0.09, 0.13, 0.10);
const MUTED      = rgb(0.45, 0.48, 0.46);

const W = 842; // A4 landscape
const H = 595;

const out = process.argv[2] || path.join(ROOT, 'assets', 'certificate-template.pdf');

const doc  = await PDFDocument.create();
doc.setTitle('Solve Energy — Certificate of Completion');
doc.setCreator('Solve Energy');

const page = doc.addPage([W, H]);

const serif     = await doc.embedFont(StandardFonts.TimesRoman);
const serifBold = await doc.embedFont(StandardFonts.TimesRomanBold);
const sans      = await doc.embedFont(StandardFonts.Helvetica);
const sansBold  = await doc.embedFont(StandardFonts.HelveticaBold);

const centre = (text, font, size, y, color = INK) => {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: (W - w) / 2, y, size, font, color });
};

// ── Frame ────────────────────────────────────────────────────
page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 1) });
page.drawRectangle({ x: 0, y: H - 10, width: W, height: 10, color: GREEN });
page.drawRectangle({ x: 0, y: 0,      width: W, height: 10, color: GREEN });
page.drawRectangle({
  x: 28, y: 28, width: W - 56, height: H - 56,
  borderColor: rgb(0.86, 0.89, 0.87), borderWidth: 1,
});

// ── Logo ─────────────────────────────────────────────────────
// assets/solve-wordmark.png is the dark wordmark. The app's own solve_logo.png
// is the light-theme SOLVE-U mark and is invisible on white — do not use it here.
try {
  const png   = await doc.embedPng(fs.readFileSync(path.join(ROOT, 'assets', 'solve-wordmark.png')));
  const logoW = 150;
  const logoH = (png.height / png.width) * logoW;
  page.drawImage(png, { x: (W - logoW) / 2, y: H - 104, width: logoW, height: logoH });
} catch {
  centre('SOLVE', sansBold, 22, H - 96, INK);
}

// ── Titles ───────────────────────────────────────────────────
centre('Certificate of Completion', serifBold, 34, H - 182);

const sub = 'This is to certify that';
centre(sub, sans, 12, H - 216, MUTED);

// ── Name (form field) ────────────────────────────────────────
const form      = doc.getForm();
const nameField = form.createTextField('name');
// addToPage first: setFontSize/setAlignment need the /DA entry it creates.
nameField.addToPage(page, {
  x: 120, y: H - 282, width: W - 240, height: 40,
  borderWidth: 0, font: serifBold,
});
nameField.setAlignment(1); // centre
nameField.setFontSize(26);

// Rule under the name
page.drawLine({
  start: { x: 150, y: H - 292 }, end: { x: W - 150, y: H - 292 },
  thickness: 0.8, color: rgb(0.82, 0.86, 0.83),
});

centre('has successfully completed', sans, 12, H - 322, MUTED);

// ── Training name (form field) ───────────────────────────────
const trainingField = form.createTextField('training');
trainingField.addToPage(page, {
  x: 110, y: H - 372, width: W - 220, height: 30,
  borderWidth: 0, font: sansBold,
});
trainingField.setAlignment(1);
trainingField.setFontSize(17);

// ── Date (form field) ────────────────────────────────────────
centre('Completed on', sans, 10, H - 410, MUTED);

const dateField = form.createTextField('date');
dateField.addToPage(page, {
  x: 240, y: H - 442, width: W - 480, height: 24,
  borderWidth: 0, font: sans,
});
dateField.setAlignment(1);
dateField.setFontSize(14);

// ── Footer ───────────────────────────────────────────────────
page.drawLine({
  start: { x: 320, y: 104 }, end: { x: W - 320, y: 104 },
  thickness: 0.8, color: rgb(0.82, 0.86, 0.83),
});
centre('Solve Energy', sansBold, 11, 86, GREEN_DARK);
centre('Issued by Solve University', sans, 9, 70, MUTED);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, await doc.save());
console.log(`✔ certificate template → ${out}`);
