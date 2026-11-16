// ─── Completion certificates ──────────────────────────────────
//
// When someone finishes a training block that carries a `Certificate Template`,
// we fill that template with their name and completion date and store the
// result on their Training Record under `Internal Certificates`.
//
// Two fields, deliberately kept apart:
//   Certificates          — what the TRAINEE uploaded as proof (Asbestos
//                           Awareness tickets, signed handbooks). Read and
//                           written by /api/upload-certificate and friends.
//   Internal Certificates — what SOLVE issued. Only this file writes it.
//
// Mixing them would make "did they give us a ticket?" unanswerable.
//
// The template is a PDF. Two ways to place the text, tried in order:
//
//   1. AcroForm text fields. Name a field `name` / `full name` / `employee
//      name`, and another `date` / `date completed`, and we fill them. This is
//      the path to design for — the designer controls position, size and font.
//   2. No form fields: we centre the name and the date at conventional
//      positions on page 1. Any PDF works, nothing has to be prepared.
//
// A template that is not a PDF is stored as-is with no text filled in, rather
// than failing the completion.

const PLACEHOLDER_RE = /\{\{\s*(name|full[_ ]?name|employee[_ ]?name|date|date[_ ]?completed)\s*\}\}/gi;

const NAME_FIELD_RE     = /^(name|full[_ ]?name|employee[_ ]?name|recipient([_ ]?name)?)$/i;
const DATE_FIELD_RE     = /^(date|date[_ ]?completed|completion[_ ]?date|completed([_ ]?on)?)$/i;
const TRAINING_FIELD_RE = /^(training|training[_ ]?name|course|course[_ ]?name|module|block([_ ]?name)?)$/i;

/** Human-readable completion date: "11 November 2026". */
function formatDate(iso) {
  if (!iso) return '';
  // Parse as a plain calendar date — `new Date('2026-11-11')` is UTC midnight,
  // which renders as the previous day anywhere west of Greenwich. Solve is in
  // BC, so that would print the wrong date on every certificate.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  const [, y, mo, d] = m;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return `${Number(d)} ${MONTHS[Number(mo) - 1]} ${y}`;
}

/** A filename that is safe on every platform and says what it is. */
function certificateFileName(blockName, personName, iso) {
  const safe = s => String(s || '')
    .replace(/[^A-Za-z0-9 _-]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  const parts = ['Certificate', safe(blockName), safe(personName), (iso || '').slice(0, 10)];
  return parts.filter(Boolean).join('_') + '.pdf';
}

/** The first file on a Notion `files` property, with a URL that works right now. */
function firstFile(prop) {
  for (const f of (prop?.files || [])) {
    const url = f.type === 'file' ? f.file?.url : (f.type === 'external' ? f.external?.url : null);
    if (url) return { url, name: f.name || 'certificate.pdf' };
  }
  return null;
}

/**
 * Build the factory for a given server context.
 *
 * Passing the server's own helpers in rather than re-implementing them keeps
 * retry behaviour, failure reporting and Notion auth identical to every other
 * call the portal makes.
 */
function createCertificates({
  PDFLib, notionFetch, uploadBytesToNotion, notionFileRef, fetchFile,
  log = console,
  // The face filled fields render in, as TTF bytes, plus the fontkit module
  // pdf-lib needs to read it. Both optional: without them the certificate still
  // comes out, in pdf-lib's default Helvetica.
  fieldFontBytes = null,
  fontkit = null,
}) {

  /**
   * The certificate template for a block, or null if it does not issue one.
   *
   * Always fetched fresh: Notion's file URLs are presigned and expire within
   * the hour, so a URL kept in the block cache is a time bomb.
   */
  async function getTemplate(blockId) {
    const page = await notionFetch(`/pages/${blockId}`);
    const file = firstFile(page.properties?.['Certificate Template']);
    if (!file) return null;
    return { ...file, blockName: (page.properties?.['Name']?.title || []).map(t => t.plain_text).join('') };
  }

  /**
   * Embed the display face the filled fields should render in, or null to let
   * pdf-lib fall back.
   *
   * This exists because `form.flatten()` regenerates every field's appearance
   * using pdf-lib's *default* font, throwing away whatever the template's own
   * default-appearance string asked for. Without this step a template built
   * around a display face still comes out in Helvetica, silently.
   */
  async function embedFieldFont(pdfDoc) {
    if (!fieldFontBytes) return null;
    try {
      if (fontkit) pdfDoc.registerFontkit(fontkit);
      // Never subset: this face renders names nobody has typed yet, and a
      // subset would punch holes through the first Renée or Muñoz.
      return await pdfDoc.embedFont(fieldFontBytes, { subset: false });
    } catch (e) {
      log.warn(`⚠️   Certificate: could not embed the field font, falling back: ${e.message}`);
      return null;
    }
  }

  /** Fill an AcroForm, if the template has one. Returns true if anything was set. */
  async function fillFormFields(pdfDoc, { personName, dateText, trainingName }) {
    let form;
    try { form = pdfDoc.getForm(); } catch { return false; }

    let fields;
    try { fields = form.getFields(); } catch { return false; }
    if (!fields || !fields.length) return false;

    let filled = false;
    for (const field of fields) {
      let name;
      try { name = field.getName(); } catch { continue; }
      const value = NAME_FIELD_RE.test(name)     ? personName
                  : DATE_FIELD_RE.test(name)     ? dateText
                  : TRAINING_FIELD_RE.test(name) ? (trainingName || '')
                  : null;
      if (value == null) continue;
      try {
        field.setText(value);
        filled = true;
      } catch (e) {
        log.warn(`⚠️   Certificate: could not set form field "${name}": ${e.message}`);
      }
    }

    if (filled) {
      // Flatten so the values are part of the page, not editable form state.
      // A certificate someone can retype is not a certificate.
      try {
        const font = await embedFieldFont(pdfDoc);
        if (font) {
          // Render appearances ourselves in the display face, then flatten
          // without letting pdf-lib regenerate them in its default font.
          form.updateFieldAppearances(font);
          form.flatten({ updateFieldAppearances: false });
        } else {
          form.flatten();
        }
      } catch (e) {
        log.warn(`⚠️   Certificate: could not flatten the form: ${e.message}`);
      }
    }
    return filled;
  }

  /** Draw the name and date centred on page 1, for a template with no form fields. */
  async function drawCentred(pdfDoc, { personName, dateText, trainingName }) {
    const { rgb, StandardFonts } = PDFLib;
    const page = pdfDoc.getPages()[0];
    if (!page) return;

    const { width, height } = page.getSize();
    const nameFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const dateFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // Shrink the name until it fits the page with a comfortable margin, so a
    // long name does not run off the edge.
    let nameSize = 28;
    const maxWidth = width * 0.8;
    while (nameSize > 10 && nameFont.widthOfTextAtSize(personName, nameSize) > maxWidth) nameSize -= 1;

    const nameWidth = nameFont.widthOfTextAtSize(personName, nameSize);
    page.drawText(personName, {
      x: (width - nameWidth) / 2,
      y: height * 0.48,
      size: nameSize,
      font: nameFont,
      color: rgb(0.08, 0.08, 0.08),
    });

    const lines = [];
    if (trainingName) lines.push(trainingName);
    if (dateText)     lines.push(`Completed ${dateText}`);

    let y = height * 0.37;
    for (const line of lines) {
      const size = 12;
      const w = dateFont.widthOfTextAtSize(line, size);
      page.drawText(line, {
        x: (width - w) / 2, y, size, font: dateFont, color: rgb(0.35, 0.35, 0.35),
      });
      y -= 20;
    }
  }

  /** Produce the finished certificate bytes from the template bytes. */
  async function fill(templateBytes, { personName, dateISO, trainingName }) {
    if (!PDFLib) throw new Error('pdf-lib is not installed');
    const { PDFDocument } = PDFLib;
    const dateText = formatDate(dateISO);

    const pdfDoc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });

    const usedForm = await fillFormFields(pdfDoc, { personName, dateText, trainingName });
    if (!usedForm) await drawCentred(pdfDoc, { personName, dateText, trainingName });

    return { bytes: await pdfDoc.save(), placedWith: usedForm ? 'form-fields' : 'centred-text' };
  }

  /**
   * Issue the certificate for a completed block, if that block has a template.
   *
   * Idempotent by default: a record that already carries an issued certificate
   * is left alone, so re-completing a module does not pile up duplicates.
   *
   * Never throws. A certificate that cannot be produced must not fail the
   * completion that earned it — the training is done either way, and a
   * swallowed error here is visible in the logs and fixable later.
   */
  async function issue({ blockId, recordId, personName, dateISO, force = false }) {
    try {
      if (!blockId || !recordId) return null;
      if (!PDFLib) {
        log.warn('⚠️   Certificate: pdf-lib is not installed — skipping');
        return null;
      }

      const template = await getTemplate(blockId);
      if (!template) return null;               // block does not issue a certificate

      if (!force) {
        const record = await notionFetch(`/pages/${recordId}`);
        if ((record.properties?.['Internal Certificates']?.files || []).length) {
          log.log(`ℹ️   Certificate: record ${recordId} already has one — leaving it`);
          return null;
        }
      }

      const isPdf = /\.pdf(\?|$)/i.test(template.name) || /\.pdf(\?|$)/i.test(template.url);

      const res = await fetchFile(template.url);
      if (!res.ok) throw new Error(`could not download the template: HTTP ${res.status}`);
      const templateBytes = Buffer.from(await res.arrayBuffer());

      let outBytes = templateBytes;
      let placedWith = 'not-a-pdf';
      if (isPdf) {
        const out = await fill(templateBytes, { personName, dateISO, trainingName: template.blockName });
        outBytes = Buffer.from(out.bytes);
        placedWith = out.placedWith;
      } else {
        log.warn(`⚠️   Certificate: template "${template.name}" is not a PDF — storing it unfilled`);
      }

      const fileName = isPdf
        ? certificateFileName(template.blockName, personName, dateISO)
        : template.name;

      const uploadId = await uploadBytesToNotion(outBytes, fileName, isPdf ? 'application/pdf' : 'application/octet-stream');

      // The PATCH response carries the stored file back with a usable URL, so the
      // caller can show it immediately without a second round trip.
      const updated = await notionFetch(`/pages/${recordId}`, 'PATCH', {
        properties: { 'Internal Certificates': { files: [notionFileRef(uploadId, fileName)] } },
      });
      const stored = firstFile(updated?.properties?.['Internal Certificates']);

      log.log(`🏅  Certificate issued to ${personName} for "${template.blockName}" (${placedWith}) → record ${recordId}`);
      return { name: fileName, blockName: template.blockName, placedWith, url: stored?.url || null };

    } catch (err) {
      // Deliberately swallowed — see the doc comment.
      log.error(`❌  Certificate issue failed for block ${blockId} / record ${recordId}: ${err.message}`);
      return null;
    }
  }

  return { issue, getTemplate, fill, formatDate, certificateFileName };
}

module.exports = { createCertificates, formatDate, certificateFileName, PLACEHOLDER_RE };
