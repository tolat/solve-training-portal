# SOLVE Training Portal — Claude Code Context

## Project Overview
Node.js/Express training portal for SOLVE Energy, deployed on Railway. Employees log in and complete training modules (quizzes, document uploads, HR document uploads, e-signatures). Data lives entirely in Notion databases via the Notion API.

## Deployment
- **Platform**: Railway (auto-deploys from GitHub on push to `main`)
- **Repo**: `https://github.com/SolveEnergy/training-portal.git`
- **Git remotes**:
  - `solve-main` → `SolveEnergy/training-portal` ← **always push here**
  - `origin` → `tolat/solve-training-portal` (old, ignore)
- **Push command**: `git push solve-main main`
- **⚠️ NEVER push to git directly — always provide commands for the user to run**

## Environment Variables (set in Railway)
- `NOTION_TOKEN` — Notion integration token
- `SESSION_SECRET` — express-session secret
- `APP_URL` — public Railway URL (must be set for file URLs to work correctly)
- `PORT` — set by Railway automatically
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` — mail server (password-recovery e-mails **and failure alerts**). Gmail needs an app password. If unset, alerts are only logged.
- `ALERT_EMAIL` — who gets failure alerts (default `torin@solveenergy.ca`); `ALERT_COOLDOWN_MIN` — minutes between repeats of the same alert (default 15)
- `DEBUG_KEY` — password for `GET /api/debug/user`. **Unset = the endpoint is switched off (503).** Send it as the `x-debug-key` header (or `Authorization: Bearer`), never in the URL: `curl -H "x-debug-key: $DEBUG_KEY" "https://solveu.solveenergy.ca/api/debug/user?email=someone@solveenergy.ca"`. 10 wrong keys in a minute locks it for that minute.
- `NOTION_RPS` (default 2.7), `MAX_CONCURRENT_UPLOADS` (default 4) — optional tuning, see "Capacity" below

## Project Structure
```
solve-training-app/
├── server.js          # Express backend — all API endpoints, Notion integration
├── certificates.js    # Issued completion certificates — fills a PDF template, stores it on the record
├── resilience.js      # Retry/backoff for outbound calls, failure e-mails, request context (see "Reliability")
├── test/              # `npm test` — resilience.js unit tests (mock HTTP server, no network)
├── index.html         # Single-page frontend shell
├── js/
│   ├── net.js         # Resilient fetch (retry/wait), connection banner (window.SolveNet) — loads before app.js
│   ├── app.js         # All frontend logic
│   ├── certificates.js # Award modal + "My Certificates" section (window.SolveCerts)
│   └── tour.js        # First-login welcome screen + guided tour (window.SolveTour)
├── css/
│   └── styles.css     # Dark theme (default) + light theme (body.logged-in)
├── uploads/           # Temp multer upload dir (ephemeral on Railway)
├── assets/            # certificate-template.pdf (generated), solve-wordmark.png, fonts/
├── bin/               # make-certificate-template.mjs — regenerates the template
├── signing-fields.json # Cached PDF signing field positions
└── CLAUDE.md          # This file
```

## Notion Database IDs
```js
companyDirectory:     '583517ad-9eb7-4c1c-b563-47ef14c9f9d3'
trainingRecords:      '2a0b73d8-b43a-8022-843f-cd9712081cbc'
trainingBlocks:       '2a8b73d8-b43a-8081-b8dd-c8d6d3f90d75'
trainingProfiles:     '2a8b73d8-b43a-809b-a218-d333d4f2a2f3'
roles:                '2b1b73d8-b43a-8013-ad34-f824f122013f'
pipelineStages:       '26fb73d8-b43a-8062-ab48-cb65735c1eb2'
trainingBlockQuizzes: '2d403da0-4fe8-4355-90aa-84ea3ea3aabc'
hrDocuments:          '366b73d8-b43a-80dc-98e1-f7df637d49c7'
```

## Key Notion Data Model
- **Training Block**: has `Name`, `Type` (multi-select), `Ordering` (number, optional), `Training link` (url), `Pipeline Stages` (relation), `Notes`, `Policy No.`, `Certificate Template` (files)
- **Training Record**: links Employee + Training Block, has `Date Completed`, `Certificates` (files — **uploaded by the trainee as proof**), `Internal Certificates` (files — **issued by Solve**), `Status`
- **Company Directory**: employees with `Roles`, `Ordered Onboarding Stage`, `Contractor Pages`, `Dealer Organizations`
- **HR Documents**: `Name`, `Person` (relation to directory), `Files & media`, `Type` (select)

## Training Block Types (multi-select field called "Type")
Detected via normalised string matching in `app.js`:
- `"Document Upload"` → `isDocumentUploadBlock()` — uploads to training record Certificates
- `"HR Document Upload"` → `isHRDocumentUploadBlock()` — uploads to HR Documents DB
- `"Signature Required"` → `isSignatureBlock()` — PDF e-signature flow
- `"Completion Certificate"` → the block issues a certificate on completion. Display-only: it does **not** change how the block is completed (see `blockNeedsQuizAndSignature`'s `special` set in `app.js`). What actually triggers issuance is the block having a **`Certificate Template`** file, not the tag.
- All others → quiz-based training (AI-generated quizzes stored in trainingBlockQuizzes DB)
- `"General Resource"` → `hasGeneralResourceTag()` / `isResourceOnlyBlock()` in `server.js`. The block's **Guidance**, **Associated forms** and **Files & media** files, plus its **Training link**, are listed in a "Documents" grid on its role's card on the main page (loaded through `POST /api/resource-files`, rendered by `loadRoleResources()` in `app.js`). Combine it with other tags and the block is still a training AND appears in the grid. In practice each role has two **General Resource-only** blocks: `<Role> Path` and `<Handbook name> (complete)` (the whole handbook as one PDF), both linked to the role's Training Profile(s). A block whose **only** tag is General Resource is not a training: it is removed from `blocks`, the role's `blockIds`, the completion counts and "Other Assigned Trainings", and `regenerateQuizForBlock` skips it, so it just gets a tile on the main page.
  - **Never give a General Resource-only block a Pipeline Stage, and do not press Sync Block on it.** Training records are created by Make ("Sync Missing Trainings Universal" 4748085 → the Employee/Contractor/Dealer "Load Missing Trainings" loaders) only for blocks that sit in a person's onboarding-stage chain, which is built from Pipeline Stages. Stage-less resource blocks therefore never get records (verified 2026-10-28: all 26 have no stage and no records). Giving one a stage would start creating Overdue records for everyone in its profiles. The portal also ignores resource-only blocks even if a record existed.

**Note**: The `Type` multi-select is what drives behaviour. The separate `Role Type` field is NOT used.

## Block Ordering & Locking Logic (app.js — renderCourse)
Within each stage group:
1. **Unordered blocks** (no `Ordering` value) → always accessible, sorted: completed → overdue → open
2. **Ordered blocks** (have numeric `Ordering` value) → rendered in order after unordered blocks
   - First ordered block is always accessible
   - Each subsequent block is locked until all lower-ordered blocks are completed
   - Locked blocks show grayed-out "🔒 Complete previous trainings first"

## Stage Filtering Logic (app.js)
- Employee's `Ordered Onboarding Stage` has a numeric prefix (e.g. "04 - Technical Training" → ordering 4)
- Blocks whose stage ordering > employee's current stage are hidden
- **Exception**: if a training record already exists for a block, always show it regardless of stage

## First-login welcome + guided tour (js/tour.js)
- `SolveTour.maybeStart()` runs at the end of `initApp()`: animated "Welcome to Solve University, <first name>", then a description with **Take me to the walkthrough** / **Skip for now**. The walkthrough spotlights UI elements (profile, stage badge, sync bar, role cards, Go to courses, Documents), steps into the first course (progress, phases, a module row, status colours) and returns to the main page.
- The welcome shows on **every visit** (fresh login, auto-login and resumed sessions) until the person has **deliberately** skipped or finished it. Deliberate = "Skip for now", "Skip tour" / Escape mid-tour, or finishing the last step. Merely starting the walkthrough, or closing the app part-way, does not count.
- Source of truth is the **`Portal Tour Completed`** checkbox on the employee's Company Directory page: `GET /api/tour-status` reads it, `POST /api/tour-complete` sets it (untick it in Notion to show someone the tour again). If the property is missing or the request fails, `tour.js` falls back to a per-browser flag (`localStorage` key `solveu_tour_seen_v1:<email>`, also written on completion); if storage is blocked too it never auto-starts. It waits while `currentUser.mustChangePassword` is true and starts after the forced password change (`doChangePassword`).
- Replay: a permanent green underlined "Watch the Solve-U Walkthrough →" link under the main-page heading (`#tourLink`), plus the "Take the tour" card on the profile screen (both call `SolveTour.replay()`). The main page heading is "Welcome Back, <first name>" with a "My Courses" heading above the role cards; their styles are inline in `index.html`. `SolveTour.abort()` is called on sign-out and on a 401.
- Steps live in the `STEPS` array: each has a `target()` returning the element(s) to spotlight; a step whose target is not visible (e.g. header hidden in embedded mode) is skipped. Its styles (`tour-*` / `tw-*`) are injected by `tour.js` itself, deliberately not in `styles.css`: the service worker serves CSS cache-first, so on the first load after a deploy new JS would otherwise run against stale CSS.

## Guidance Blurb (app.js — openBlock)
When a training block is opened, a contextual blue info banner appears:
- **Video link** (YouTube/Vimeo/mp4): "📹 Watch the video above, then click..."
- **External link**: "🔗 Complete the training at the link above, then click..."
- **No link, regular block**: "📄 Read or review the materials below, then click..."
- **Doc/HR upload + video**: "📹 Watch the video above, then upload below"
- **Doc/HR upload + external link**: "🔗 Review the resource at the link, then upload below"
- **Doc/HR upload, no link**: no blurb (noLinkBox handles it)
- **Signature blocks**: no blurb, no noLinkBox

## File Upload — Notion Native API (server.js — uploadFileToNotion)
HR document uploads use Notion's File Upload API (NOT external URLs):
1. `POST https://api.notion.com/v1/file_uploads` with `{ mode: 'single_part', filename, content_type }` → get `id`
2. `POST https://api.notion.com/v1/file_uploads/{id}/send` with multipart FormData, field `file`
3. Reference in Notion properties as `{ type: 'file_upload', file_upload: { id } }`
4. Uses Notion-Version: `2026-03-11`
- Do NOT set `Content-Type` header manually on the send step — fetch sets it with boundary automatically

**Certificate uploads (`/api/upload-certificate`) and signed documents (`/api/sign-document`) use the same flow** (`uploadFileToNotion` / `uploadBytesToNotion` + `notionFileRef`): the file is stored by Notion and the training record's `Certificates` property references it as a `file_upload`. Nothing is kept on the server's disk (multer's temp copy is deleted after upload) and there is no `/uploads` route. Do not go back to linking files by the portal's own URL: Railway's disk is wiped on every deploy and those links die (5 records already lost their files this way in Oct 2026). Re-uploading replaces the record's `Certificates` list.

## Session Data (req.session)
```js
{
  pageId,            // Notion page ID for the employee
  name,
  email,
  roleIds,           // array of role IDs
  onboardingStage,   // e.g. "04 - Technical Training"
  contractorPageIds, // array
  dealerOrgPageIds,  // array — must be destructured in every endpoint that queries records
}
```
**Common bug to watch**: endpoints that query training records must destructure `dealerOrgPageIds = []` from `req.session` or the dealer lookup throws "dealerOrgPageIds is not defined".

## Key API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/login` | Email + password auth |
| GET | `/api/training-data` | All blocks, records, roles for the logged-in user |
| POST | `/api/submit-quiz` | Submit quiz answers, mark record complete |
| POST | `/api/upload-certificate` | Upload cert files → training record Certificates field |
| POST | `/api/upload-hr-document` | Upload to HR Documents DB via Notion file upload API |
| POST | `/api/sign-document` | PDF e-signature → stamps PDF, marks record complete |
| POST | `/api/sync` | Refresh employee data + training cache |
| GET | `/api/tour-status` | `{ tourCompleted }` from the Company Directory checkbox (null if the property is missing) |
| POST | `/api/tour-complete` | Sets `Portal Tour Completed` on the logged-in employee |
| GET | `/api/my-certificates` | Every certificate Solve has issued the logged-in person (reads `Internal Certificates`), newest first |
| POST | `/api/resource-files` | `{ blockIds }` → files (Guidance / Associated forms / Files & media) and Training link for General Resource blocks (cached 20 min server-side) |

## CSS Theming
- Default (pre-login): dark theme, CSS vars set in `:root`
- Post-login: `body.logged-in` class applied — light theme, vars overridden in `body.logged-in { ... }`
- Higher specificity (`body.logged-in .some-class`) overrides base dark-mode rules
- **Inline styles in `index.html` `<style>` tag** are used for some components to avoid CSS file caching/deployment issues (e.g. `.block-guidance-blurb`)

## Service worker (sw.js) and uploads
- The service worker only handles **GET** requests (`if (request.method !== 'GET') return;`). It must never intercept writes: re-sending a request body from the service worker truncates large multipart uploads on iOS Safari (server log: `Error: Unexpected end of form`, client: "Server error 500"), which broke photo uploads on iPhones (Nov 2026). JSON writes happened to work, multipart did not. Bump `CACHE_NAME` whenever sw.js or cached CSS/images change; phones pick the new worker up on their next load of the app.
- `server.js` ends with a JSON **error handler** (multer/body-parser errors → a clear message: file too large 413, interrupted upload 400, otherwise "Something went wrong"), and deletes any half-written temp file recorded in `req._tmpUploads`.

## Document signing layout (js/app.js — renderSigningPDF)
- **Pages fit the screen**: each page is `min(<rendered width>, 100vw - 32px)` wide (desktop keeps the full 918px page; a phone shrinks it to fit). The canvas fills its wrapper and field overlays are positioned in **% of the page**, so they stay aligned at any size. The render scale drops on phones (≥1×, ≤1.5×) to save memory on long documents. The synthetic "Electronic Signature" page is also %-based (US letter aspect ratio).
- **Signature pad canvases are sized to their on-screen size** by `fitSignaturePads()` (ResizeObserver + orientationchange), at devicePixelRatio, rescaling any strokes already drawn. Never hard-code a pad's pixel size: SignaturePad maps pointer coordinates in CSS pixels.
- **On phones (≤700px wide) signing is tap-to-sign**: signature/initials boxes show "Tap to sign" and open a full-width bottom-sheet pad (`openSignaturePadModal`); **Done** trims the drawing (`trimCanvas`) and fits it into the field's own pad with `applyPhoneSignature` (so `submitSignedDocument` is unchanged). Desktop signs in place. The phone rules and modal styles are injected from JS (`injectSignStyles`) so a stale cached stylesheet can't break them.
- **"Take Me To Signatures" / "Next Signature" bar** (`setupSignatureNav`): sticky under the app header, steps through signature/initials fields in document order.
- Testing in the Browser pane: when the pane is hidden `requestAnimationFrame` never fires and pdf.js renders hang; replace it with a `setTimeout` shim in the page before opening a document.

## Completion certificates (`certificates.js`, `js/certificates.js`)

When someone completes a block that has a **`Certificate Template`** file, the
portal fills that template with their name, the training name and the
completion date, and stores the result on their Training Record under
**`Internal Certificates`**.

**The two certificate fields are deliberately separate and must stay that way:**

| Field | Holds | Written by |
|---|---|---|
| `Certificates` | what the **trainee uploaded** as proof (Asbestos ticket, signed handbook) | `/api/upload-certificate`, `/api/sign-document`, `/api/upload-hr-document` |
| `Internal Certificates` | what **Solve issued** | `certificates.js` only |

Mixing them would make "did they give us a ticket?" unanswerable.

**Where it runs.** `issueCertificateFor()` in `server.js` is called from every
path that writes `Date Completed` — `/api/complete`, `/api/upload-certificate`,
`/api/upload-hr-document`, `/api/sign-document` — and each returns
`certificate: {...}` or `certificate: null` in its JSON. The client calls
`awardCertificate(result.certificate)`, which no-ops on null.

Deliberately **not** a Notion automation: a Notion automation does not fire
another Notion automation, only API writes do, so an automation watching
`Date Completed` would never run when the portal set it.

**It never throws.** The completion is already recorded by the time issuance
runs; a certificate that cannot be produced is logged and skipped, and can be
reissued later with `force: true`. A failed certificate must never turn a
finished training into an error the person sees.

**Idempotent.** A record that already has an issued certificate is left alone,
so re-completing a module does not pile up duplicates.

**Template.** `assets/certificate-template.pdf`, generated by
`node bin/make-certificate-template.mjs` so the wording, spacing and colours are
reviewable in a diff rather than being an opaque binary. It carries AcroForm
text fields `name`, `training` and `date`; `certificates.js` fills them and then
**flattens the form** (a certificate someone can retype is not a certificate).
A template with no form fields still works — the name, training and date are
centred on page one. A designer can supply any PDF: name the fields `name`,
`training`, `date` and it is filled precisely; omit them and it still works.

### Design

A classic award certificate, built from a reference Torin supplied: sweeping
ribbons in the top-right and bottom-left corners, a thin gold double frame, a
heavy green title, and the recipient's name in script. The greens are Solve's
own from `css/styles.css` `body.logged-in` (`#2a9640`, `#217832`, `#152219`),
deepened to `#13401f` for the ribbons so they read as layered rather than flat.
Gold is the one colour from outside the product palette; it is what makes this
kind of certificate look like one.

The ribbons are built by `bandTopRight()` / `bandBottomLeft()`: each band is
the area between two quarter-ellipses sharing a corner, and giving the outer
and inner arcs different width:height ratios is what makes a band taper like a
ribbon instead of sitting like a rainbow stripe.

The foot has the completion date on the left and a signature rule on the right
with **Kane Hammontree, CEO** under it, the space above deliberately empty for
a signature. Content centres on `AXIS = 400`, left of the page centre, to stay
clear of the top-right ribbon.

### Typography, and the traps — all silent

| Role | Face |
|---|---|
| Recipient's name | **Allura** (script) |
| Title, training | **Inter** Bold / SemiBold |
| Labels, date | **Inter** Regular |

All SIL OFL, in `assets/fonts/` with the licences. All embedded **whole**.

1. **`addToPage(page, {font})` does not set a field's font.** It has to be
   `form.updateFieldAppearances(font)` before save, and rewriting a field's
   default appearance also rewrites the size baked into it, so `setFontSize()`
   has to run again afterwards.
2. **`form.flatten()` regenerates appearances in pdf-lib's *default* font.**
   `certificates.js` therefore embeds the faces itself, calls
   `field.updateAppearances(font)` **per field**, then
   `flatten({ updateFieldAppearances: false })`. Per field matters: the name is
   script and the training and date must not inherit it. Skip this and the
   whole thing comes out in Helvetica while the static title still looks right.
3. **The field fonts must not be subsetted.** A subset carries only the glyphs
   drawn at build time, so the first Renée or Muñoz gets holes punched through
   their own name.
4. 🔴 **A face can carry a glyph and still render it wrongly.** Great Vibes was
   the first script choice; it draws a precomposed `é` a clear space away from
   the letter before it, so "Renée" comes out as "Ren ée". pdf-lib's own
   metrics do **not** show this — it measures the string correctly. Allura
   renders it properly and was chosen for that reason.
5. **A text field paints its own background**, white by default. The training
   field starts at `x = 200` because at its height the bottom-left ribbon
   reaches `x = 173`, and a white slab over the ribbon is very visible.
6. **`drawSvgPath`'s y axis runs downward** from the origin it is given, unlike
   every other call on the page. `svgPath()` converts once, internally.

`test/certificates.test.js` guards 1–4. Both font tests work by **measuring
what was rendered** and comparing it against the face's own metrics:

- the name test catches (1)–(3) — asserting "the face appears in the page
  fonts" does **not** work, since the title uses it either way, and that
  version passed while the name was Helvetica;
- the accent test catches (4), because a broken advance makes the rendered
  width disagree with the metric width.

Both are verified by reintroducing the bug and watching them fail.

Fonts are wired in `server.js` (`CERT_FIELD_FONTS` / `CERT_FONTKIT`) as a map
keyed by field role, and are optional: if a file or `@pdf-lib/fontkit` is
missing, certificates still issue, just in Helvetica.

> `solve_logo.png` is the **light-theme** SOLVE-U mark and is invisible on a
> white certificate. `assets/solve-wordmark.png` is the dark one used here.

**URLs expire.** Notion's file URLs are presigned for about an hour, so the
template URL is fetched fresh on every issuance and `/api/my-certificates` is
never cached. Only a `hasCertificate` boolean is kept in the block cache.

**Adding another display-only Type tag?** Add it to the `special` set in
`blockNeedsQuizAndSignature()` (`js/app.js`), or every block carrying it starts
demanding a quiz and a signature. This caught `General Resource` in Oct 2026 and
`Completion Certificate` was added to that set for the same reason.

## Reliability: retries, feedback and failure e-mails
Goal: an integration hiccup (Notion/Anthropic timeout, 429, 5xx, dropped connection) should not break the portal; people wait and it retries, they see what is happening, and Torin gets an e-mail if it does not recover.

**Back end (`resilience.js`, used by `server.js`)**
- `notionFetch`, `uploadFileToNotion`, the PDF downloads and both Anthropic calls go through `resilience.fetchWithRetry`: per-attempt timeout (25 s Notion), up to 5 tries, exponential backoff with jitter, honours `Retry-After`, 60 s overall budget.
- **A write is never blindly re-sent.** "Safe" failures (429, 503, 409, connection refused/DNS) are retried for every method; "ambiguous" ones (timeouts, resets, 500/502/504) only for idempotent calls (GET, PATCH, database `/query`, same-bytes upload). A page-creating `POST /pages` is not retried after a timeout/500. Record writes are made safe by the handlers themselves (look up the record, update or create), so the browser can safely repeat a whole request.
- When retries run out the failure is e-mailed to `ALERT_EMAIL` (throttled: one e-mail per distinct failure per 15 min, max 12/hour, repeat counts included; never contains tokens). No SMTP configured → logged as `🚨 ALERT (not e-mailed …)`. Background problems (24 h refresh, webhooks, startup failure, quiz generation, unhandled rejections/crashes) are reported via `resilience.reportError`.
- `requestContext` middleware: if a handler ends in a 500 after a transient integration failure it is rewritten to **503 `{ error: <friendly>, retryable: true, notified: true }`** + `Retry-After`; unrelated 500s stay 500. New handlers don't need to do anything.
- `refreshCacheReliably()` (24 h timer, Notion webhooks) retries the whole refresh after 20 s / 60 s / 3 min; the old cache is kept until a refresh succeeds. Foreground "cache older than 24 h" checks fall back to the stale cache instead of failing the request.
- Quiz generation stops (and keeps the existing quiz) if any of a block's documents or its page text cannot be loaded, instead of generating from partial content.
- **Big PDFs in quiz generation:** Anthropic rejects a request over 32 MiB and a base64 PDF is 4/3 the file size, so a PDF over ~24 MB cannot be attached. `generateQuizForBlock` attaches PDFs natively while the request stays under `MAX_ATTACH_BASE64` (30 MB of base64) and sends any bigger PDF as its extracted text (`extractPdfText`, pdfjs-dist legacy build, no canvas needed; images/layout are lost). If the API still rejects a PDF (size or page count) it retries once with every PDF as text. A PDF with no readable text that is too big fails with a "shrink the PDF" message. `.npmrc` sets `omit=optional` so the optional `canvas` dependency of pdfjs-dist is never installed. Oct 2026: ten blocks had a single PDF over 25 MB (branded handbook parts and SES safety docs with multi-MB cover/photo images); shrinking those images at the source is still worthwhile because it keeps the quiz built from the full PDF.
- `GET /api/health` — cheap liveness + cache age for an uptime monitor. Startup still exits if Notion is unreachable (Railway keeps the previous deployment live).

**Front end (`js/net.js`, `apiFetch` in `app.js`)**
- `SolveNet.fetch` retries network errors and 429/502/503/504 (waits 2 s, 5 s, 10 s), waits for the connection when the device is offline, and shows a bottom banner (reconnecting / still working / back online / "couldn't reach the system — team notified"). `apiFetch(path, method, body, { quiet, waits })`: `quiet` = no banner (background work).
- Login, forgot-password, uploads and employee-id sign-in use `SolveNet.fetch` too. The banner's styles are injected by `net.js` (service worker caches CSS cache-first).
- **Passed quizzes are never lost:** if `/api/complete` still fails, the block is queued in `localStorage` (`solve_pending_completions_v1:<email>`), shown as complete via `overlayPendingCompletions()`, and re-sent by `flushPendingCompletions()` (every minute, on `online`, on sync/load). Sync only re-reads Notion, so without the queue the pass would vanish.
- If `/api/training-data` cannot be loaded, `initApp` uses the saved copy on the device (any age) with a banner and retries every minute; with no saved copy it shows the message and a "Try again" button. A transient failure no longer logs a resumed session out.
- Not covered: if the portal itself is down (Railway 502 / process dead) nothing can e-mail from the app. Point an uptime monitor at `/api/health`.

## Capacity (audit 2026-11-16, 50-60 people at once)
Notion allows ~3 calls/second for the whole integration, shared by every user; that, not the server, is the limit. Before these changes ~20 simultaneous users was the ceiling (auto-sync broke at 30; at 60, 78% of Notion calls were rate-limited). After them, 60 people ran with 0 rate-limit errors and 0 failed actions in the load test (mock Notion with a 3/s limit and measured latencies).
- **`paceNotion()`** puts every Notion call (incl. file uploads) through one 2.7/s queue, so a burst waits its turn instead of retrying in lockstep and exhausting the 5 attempts. A 60-person login burst therefore queues (login ~12 s) rather than fails.
- **`/api/sync` no longer re-reads the training library for every user**: `refreshCacheShared()` shares one in-flight refresh and skips it if the cache is under 5 minutes old (the 24 h timer and Notion webhooks still refresh it).
- **The client's 15-minute auto-sync has 0-5 minutes of random jitter** (`scheduleAutoSync()` in `js/app.js`), so people who logged in together don't sync in the same second.
- **`filter_properties`**: reads ask Notion for only the properties the portal uses (`PROPS` in `server.js`). The Company Directory page has ~160 properties incl. formulas and Roles took 3.9 s unfiltered vs 0.4 s filtered. **Keep `PROPS` in step with the code that reads each row** — a property that is read but not listed comes back missing. A listed property that was renamed/removed in Notion makes Notion answer 400; `notionFetchFiltered` then reads unfiltered and e-mails a warning (nothing breaks, it just gets slower). Not filtered: the contractor/dealer page and record reads in `/api/training-data`, `/api/complete`, uploads.
- **Uploads**: at most `MAX_CONCURRENT_UPLOADS` (4) files are in memory / on their way to Notion at once (`withUploadSlot`); 60 people uploading a 5 MB photo together peaked at 1.1 GB before, ~240 MB now. Temp files get a random suffix so two same-named uploads in the same millisecond can't share a path.
- `issueCertificateFor` returns early (no Notion call) when the cached block has no `Certificate Template`; the tour flag is cached on the session once true.
- Railway: one replica, limit 24 GB RAM / 24 vCPU. Sessions are in memory, so any restart or deploy logs everyone out: don't deploy during a live training session, and avoid editing Training Blocks in Notion then (the webhook does a full refresh + quiz regeneration).

## notionFetch Helper
```js
async function notionFetch(endpoint, method = 'GET', body = null)
// Uses NOTION_TOKEN, Notion-Version: 2022-06-28, Content-Type: application/json
// For file upload endpoints, use direct fetch() with Notion-Version: 2026-03-11
```

## Known Issues / Pending Work
1. Old training records may still hold dead links from before this fix: `https://solve-training-portal-production.up.railway.app/uploads/...` (5 records) and `http://localhost:...` (3 records). The files are gone; they need to be re-uploaded by hand.
2. Webhook and quiz-regeneration endpoints (`/api/webhook/notion*`, `/api/regenerate-quiz/:id`, `/api/regenerate-missing-quizzes`, `/api/webhook/signature-fields`) are unauthenticated, and `express.static(__dirname)` publishes the app's own source files (never put reports or notes inside this folder). Both are known and not yet fixed. (`/api/debug/user` is now protected by `DEBUG_KEY`.)
3. Every employee's default password is the hard-coded string in `/api/login` until they change it; the portal forces a change on first login.
