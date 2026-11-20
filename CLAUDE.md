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
│   ├── mobile-nav.js  # Phone header + slide-out menu (window.SolveNav)
│   └── tour.js        # First-login welcome screen + guided tour (window.SolveTour)
├── css/
│   └── styles.css     # Dark theme (default) + light theme (body.logged-in)
├── uploads/           # Temp multer upload dir (ephemeral on Railway)
├── assets/            # certificate templates (generated), wordmarks, fonts/
├── bin/               # make-certificate-template*.mjs — regenerate the templates
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
- **Training Record**: links Employee + Training Block, has `Date Completed`, `Uploads` (files — **uploaded by the trainee as proof**), `Certificates` (files — **issued by Solve**), `Status`
- **Company Directory**: employees with `Roles`, `Ordered Onboarding Stage`, `Contractor Pages`, `Dealer Organizations`
- **HR Documents**: `Name`, `Person` (relation to directory), `Files & media`, `Type` (select)

## Training Block Types (multi-select field called "Type")
Detected via normalised string matching in `app.js`:
- `"Document Upload"` → `isDocumentUploadBlock()` — uploads to training record Certificates
- `"HR Document Upload"` → `isHRDocumentUploadBlock()` — uploads to HR Documents DB
- `"Signature Required"` → `isSignatureBlock()` — PDF e-signature flow
- `"Completion Certificate"` → the block issues a certificate on completion. Display-only: it does **not** change how the block is completed (see `blockNeedsQuizAndSignature`'s `special` set in `app.js`). What actually triggers issuance is the block having a **`Certificate Template`** file, not the tag.
- All others → quiz-based training (AI-generated quizzes stored in trainingBlockQuizzes DB)
- `"Unlock Sequentially"` → `unlocksSequentially()` in `app.js`. The block stays locked until **every** course above it on the page is complete, **earlier phases included**. The ordinary ordering rule only looks within a block's own phase, so a block with `Ordering` 4 in Phase 1 ignores anything outstanding in Phase 0; this tag does not. Display-only in every other sense: it does not change how the block is completed.
  - `renderCourse` therefore works out the whole render order **before drawing anything** (`sections` → `sequence` → `seqIndex`) and locks against that flat list. The order is what the rule means by "above": unordered blocks first within a phase, sorted by status, then the ordered ones.
  - It works on a block with **no `Ordering`** too, where the ordinary rule does nothing at all.
- `"General Resource"` → `hasGeneralResourceTag()` / `isResourceOnlyBlock()` in `server.js`. The block's **Guidance**, **Associated forms** and **Files & media** files, plus its **Training link**, are listed in a **"Quick Reference Documents"** grid on its role's card on the main page (loaded through `POST /api/resource-files`, rendered by `loadRoleResources()` in `app.js`). Combine it with other tags and the block is still a training AND appears in the grid. In practice each role has two **General Resource-only** blocks: `<Role> Path` and `<Handbook name> (complete)` (the whole handbook as one PDF), both linked to the role's Training Profile(s). A block whose **only** tag is General Resource is not a training: it is removed from `blocks`, the role's `blockIds`, the completion counts and "Other Assigned Trainings", and `regenerateQuizForBlock` skips it, so it just gets a tile on the main page.
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

## Pull down to refresh (`js/pull-to-refresh.js`)

Phones only. Drag past the top and a spinner comes down with the finger; let go
past the threshold and it runs `manualSync()` — the same thing Sync now does,
which is otherwise two taps away in the menu.

The travel is rubber-banded, `MAX * (1 - e^(-dy/MAX))`, so it follows the
finger at first and stiffens as it goes. With `MAX = 160` and
`THRESHOLD = 96` that works out at about **140px of finger travel** to arm it.
The disc lands at `dist + TOP_GAP - HIDE`, which keeps it clear of the 56px
phone header rather than sitting on top of it; it parks ~45px below the header
while it works.

> 🔴 It has to take the gesture over. `preventDefault()` on touchmove is what
> stops the browser overscrolling underneath — hence `{ passive: false }`,
> without which the call is ignored — and `overscroll-behavior-y: contain`
> disables **Chrome on Android's own pull-to-refresh**, which reloads the whole
> page. Sessions are in memory, so that would sign everyone out.

It stays out of the way unless the page is at the very top, signed in, on a
phone, and nothing is over it (the menu, the award modal, the walkthrough, a
video, the signature sheet) — and never on the signing screen, which is
canvases and signature pads.

## UI vocabulary: "course", not "training"

Everything a trainee reads says **course**. The Notion side is still Training
Blocks and Training Records, and so are the identifiers, API paths and comments
in the code — `trainingData`, `/api/training-data`, `'Training Block'`. Only
display strings were changed (2026-11-17), so the code keeps the data model's
vocabulary and the screen keeps the user's.

> The two senses of "course" now overlap: the main page calls a **role** a
> course ("My Courses"), and each row inside one is also a course. That is
> Torin's call — the role cards already read "3 courses due" meaning individual
> items. If it ever needs separating, the role-level word is the one to change.

## The phone's header and menu (`js/mobile-nav.js`)

Under **600px** the two-row header collapses to one: the SOLVE-U mark on the
left, **Back** (when there is one) and a menu button on the right. Everything
the second row carried — the onboarding stage, the profile chip, Sign Out —
plus **Sync now**, which used to sit on the main page, moves into a drawer that
slides in from the right. Desktop is untouched: every rule is inside the media
query.

The drawer **reads** the stage from `#headerStage` and the last-synced line
from `#syncBarRolesText` when it opens, rather than keeping its own copy, so
the two cannot drift. `Profile` / `Sync now` / `Sign out` call `showProfile()`,
`manualSync()` and `logout()` — resolved at click time, since `app.js` loads
after this file.

> 🔴 **It injects its own CSS, and so must anything whose markup and styling
> ship together.** `css/styles.css` is served **cache-first** by the service
> worker while JS is network-first, so on the first load after a deploy the new
> markup meets the *previous* stylesheet. That is exactly what happened to the
> "courses due" chip: the class was renamed in `app.js`, the rule was added to
> `styles.css`, and on phones the chip rendered unstyled. Its rule now lives in
> `mobile-nav.js` too. Bumping `CACHE_NAME` fixes the *next* load, not the one
> that is happening.

The header controls are shown by `app.js` with inline styles, so hiding them on
a phone needs `!important`.

The same file carries the other phone-only layout rules — currently the course
rows, where the status drops below the title instead of sitting beside it,
indented past the number badge. A date beside a title left the title a narrow
column that wrapped to three lines.

**Completion dates** go through `prettyDay()` in `app.js`. Notion returns
whatever the property holds — `2026-11-16` for a date, or the full
`2026-07-27T13:13:00.000-07:00` when a time is set, which was being printed
raw. It reads only the leading `YYYY-MM-DD`: `new Date('2026-11-16')` is UTC
midnight and renders as the day before across North America, and converting the
datetime form to the viewer's timezone would show a different day from the one
Notion shows.

The walkthrough follows: `onPhone()` is "is the menu button visible", not a
width, so it tracks the stylesheet. On a phone the first step becomes the menu
and the separate stage and sync steps drop out via `available()` — three
spotlights on one button would be silly. A step's `title` may be a function as
well as its `text`.

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
| POST | `/api/upload-certificate` | Upload proof files → training record `Uploads` field |
| POST | `/api/upload-hr-document` | Upload to HR Documents DB via Notion file upload API |
| POST | `/api/sign-document` | PDF e-signature → stamps PDF, marks record complete |
| POST | `/api/sync` | Refresh employee data + training cache |
| GET | `/api/tour-status` | `{ tourCompleted }` from the Company Directory checkbox (null if the property is missing) |
| POST | `/api/tour-complete` | Sets `Portal Tour Completed` on the logged-in employee |
| GET | `/api/my-certificates` | Every certificate Solve has issued the logged-in person (reads `Certificates`), newest first |
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
**`Certificates`**.

**The two file fields are deliberately separate and must stay that way:**

| Field | Holds | Written by |
|---|---|---|
| `Uploads` | what the **trainee uploaded** as proof (Asbestos ticket, signed handbook) | `/api/upload-certificate`, `/api/sign-document` |
| `Certificates` | what **Solve issued** | `certificates.js` only |

Mixing them would make "did they give us a ticket?" unanswerable.

> 🔴 **Renamed 2026-11-17, and the names swapped sides.** `Internal
> Certificates` → **`Certificates`**, and the old `Certificates` (the
> trainee's uploads) → **`Uploads`**. Notion renames by property id, so no
> data moved — but every consumer binds by **name**, so for a few hours the
> portal's upload endpoints were writing a trainee's file into the field that
> holds their issued certificate. If you see `Internal Certificates` anywhere,
> it is stale. Make scenario **4451925** (Docusign → Update Training Record On
> Envelope Complete) writes the signed document by name too and had to be
> changed with it.

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

### What the certificate calls the training — `Certificate Title`

A select on the Training Block. Empty or **"Block Title"** means use the
block's own name. Anything else is a **pattern**: every `[tag]` is substituted,
so `Certified [Role]` becomes *Certified Warehouse Coordinator* for whoever
completes it from that role's course. Tags are case- and space-insensitive;
`[Role]`, `[Course]`, `[Block]` and `[Title]` are understood.

🔴 **A tag with no value abandons the pattern for the block name.** A block
opened from "Other Assigned Trainings" has no role in context, and a
certificate reading *Certified [Role]* is far worse than a plainer one.

`resolveCertificateTitle()` lives in `certificates.js` (not `server.js`) purely
so it can be unit-tested; `test/certificates.test.js` covers the fallbacks.
The role reaches the server because every completion path now sends
`roleName` — including queued offline completions, which store it so a replay
days later still resolves the pattern.

> `'Certificate Title'` had to be added to **`PROPS.block`**. A property read
> but not listed there comes back missing under `filter_properties`, silently.

### Where certificates show up

- **Main page**, above *My Courses* — `#certSection`, `SolveCerts.renderSection()`
- **Block page**, above the training materials — `#blockCertificate`,
  `SolveCerts.renderForBlock(blockId, host)`; hidden when that block issued none
- **On completion** — the award modal

All three read one cached list (`SolveCerts.list()`, 15 minutes). The cache is
deliberately short because Notion's file URLs expire in about an hour, and
`SolveCerts.invalidate()` runs on issuance so a new certificate appears at once.

Each card carries a thumbnail of page one of the certificate itself, cropped to
fill its frame (cover, not contain), drawn with the portal's existing pdf.js
setup (`ensurePdfWorker` in `app.js`) straight from the Notion file URL — no proxy, those URLs are fetchable cross-origin, which the
Quick Reference Documents thumbnails already relied on. The medal shows while it
loads and stays if it fails; an empty white frame would read as broken.

> A canvas takes its size from its pixel buffer, so `width: auto` means "twice
> as big" on a 2x screen rather than "fit the box", and `object-fit` is
> unreliable on one. The cover scale is therefore worked out in `drawThumb` and
> written to the canvas's `style.width`/`style.height`; the frame's
> `overflow: hidden` does the cropping.

> **The thumbnails load only as their cards come into view** (IntersectionObserver,
> 200px margin, once each). An issued certificate is ~1.2 MB — the fonts are
> embedded whole — so drawing a 72px picture means downloading the whole file.
> Six certificates would otherwise pull 7 MB on every visit to the main page,
> mostly for cards below the fold. Shrinking the certificates themselves is the
> better fix and is listed under Known Issues.

Each card is labelled with **what the certificate says**, not the block it came
from — the block is "Upload Signed Onboarding Path" and the certificate is
"Lead Solar Installer Certification", and the two have to agree.

> 🔴 **The resolved title only survives in the stored file's name.** The
> Training Record does not keep it, and it cannot be re-derived at read time: a
> `[Role]` pattern needs the role the person completed the block under, and for
> a contractor role that is worked out inside `/api/training-data` from their
> contractor records — far too much work to repeat on a read, and unknowable
> from the record alone. So `titleFromCertificateFile()` parses it back out of
> `Certificate_<title>_<person>_<date>.pdf`, anchoring on the date and person
> at the end so an underscore in the title survives. It is paired with
> `certificateFileName()` by a round-trip test: change one and the other fails.
>
> Lossy in two small ways, both confined to the label — spaces became hyphens
> on the way in, so a title with a real hyphen reads with a space, and stripped
> punctuation is gone. The PDF itself is untouched. If this ever needs to be
> exact, the fix is a property on the Training Record written at issuance.

The award modal was already right: `issue()` returns the resolved title as
`blockName`.

> 🔴 **`js/certificates.js` and `js/tour.js` must load before `js/app.js`.**
> `app.js` ends with `boot()`, which runs the moment the file executes, and on the
> common path — a stored token plus a training cache under `CACHE_TTL` — it reaches
> `renderRoles()` with **no `await` in between**. The whole first render therefore
> happens synchronously while the parser is still on that `<script>` tag. Both call
> sites are guarded with `if (window.SolveCerts)` / `if (window.SolveTour)`, so with
> those files loaded *after* `app.js` the guard just failed: the certificates
> section **and** the first-login welcome were silently skipped on every cached
> reload, and only appeared once a sync re-rendered the page (found 2026-11-17 —
> "I have to click Sync now after a refresh for it to show up"). Loading them first
> is safe; neither calls into `app.js` at load time.

### 🔴 A cached `hasCertificate: false` must never suppress issuance outright

`issueCertificateFor` skips the Notion call when the cached block has no
`Certificate Template`. That is a capacity optimisation, and on 2026-11-17 it
silently swallowed a real certificate:

| Time (UTC) | |
|---|---|
| 02:54:40 | Notion webhook fires; refresh runs **and completes** (`Cache ready — 280 blocks`) |
| 02:55:00 | the template actually lands on the block — 20s *after* the refresh read it |
| 02:57:14 | completion → upload recorded, **no certificate, and no log line saying why** |
| 02:58:56 | manual Sync — but `refreshCacheShared()` skips a refresh under 5 minutes old, so this did nothing either |

Two separate things conspire: **a Notion webhook can fire before the edit that
triggered it is visible to a read**, and the 5-minute shared-refresh window
means a manual sync straight afterwards is a no-op.

So a cached `false` is now **confirmed against Notion once per block per cache
generation** (`noCertificateBlocks`, cleared by `refreshCache`). Steady state
still costs no extra Notion call per completion, which is why the skip exists,
but a template attached at any point takes effect on the next completion.

It also logs when it finds one the cache had not seen. The original failure was
invisible precisely because the skip was silent.

### The templates

Two are built, and **a block issues whichever one is attached to it** in Notion
— nothing in the code picks between them.

| | `certificate-template.pdf` | `certificate-template-dark.pdf` |
|---|---|---|
| Built by | `bin/make-certificate-template.mjs` | `bin/make-certificate-template-dark.mjs` |
| Artwork | drawn in code over `certificate-base.png` | the supplied `certificate-dark-base.pdf`, untouched |
| Page | A4 landscape, 842 x 595 | **US Letter landscape, 792 x 612** |
| Fields | `name`, `training`, `date` | + `certificate_no` |
| Ink | black on cream | light on a dark plate |

Both carry AcroForm text fields that `certificates.js` fills and then
**flattens** (a certificate someone can retype is not a certificate). A
template with no form fields still works — the name, training and date are
centred on page one. A designer can supply any PDF: name the fields `name`,
`training`, `date`, `certificate_no` and they are filled precisely; omit them
and it still works.

The dark one adds the fields and **Kane's signature**, and draws nothing else. Its coordinates were
measured off a 150 dpi render by scanning for the plate's own rules, and its
ink colours were sampled from the plate's own text, so a filled certificate
matches the design that was handed over. None of the light template's
coordinates carry over — the page is a different size.

**The signature** is `assets/kane-signature.png`, drawn above the middle foot
rule — fitted to the rule rather than placed at a fixed size, so re-cropping or
re-scanning it moves nothing. It is optional: with no file the rule stays empty
and the template still builds.

> It is **white ink on transparent**, which is what this plate needs — a
> signature scanned black-on-white would be invisible on it, the same trap as
> the SOLVE-U wordmark on the light certificate, in reverse. That also makes it
> look like an empty image in any preview that composites onto white, which is
> exactly what happened when it was first sent: check the pixels, not the
> preview. The shipped copy is trimmed to the ink and resized to 800px wide
> (~440 dpi at its printed 131pt), because it rides inside every certificate.

**`CERTIFICATE No.`** is the last 8 hex characters of the Training Record's
Notion id, as `SU-XXXX-XXXX` (`certificateNumber()`). Stable across re-issues
and resolvable — the record whose id ends in those characters is the one that
was issued. Notion ids share a leading prefix, so it has to be the tail. A
reference, not a key.

> 🔴 **`PDFDocument.save()` runs `form.updateFieldAppearances()` unless you
> pass `{ updateFieldAppearances: false }`, and that resolves an auto-size.**
> A field left at `0 Tf` gets measured against its *empty* value and written
> back at a fixed size — so the template ships with auto-sizing silently gone
> and the first long name is clipped at the end of the rule instead of
> shrinking. Here `0 Tf` became `32 Tf` and "Christopher Alexander
> Rodriguez-Fernandez" lost four letters. The same call would also repaint the
> text black, which on this plate is invisible.
>
> `name` and `training` are deliberately auto-sized: neither length is known
> when the template is built (a title is a `[Role]` pattern), and pdf-lib
> clips rather than shrinks at a fixed size. A short value cannot balloon,
> because the fit is to the box *height* as well as its width — the 38 pt name
> box caps at about 25 pt. `date` and the serial are fixed-length, so they are
> set outright.
>
> `test/certificates.test.js` guards this by reading the built template's /DA
> strings back: auto-size intact, ink light. Verified by reintroducing the bug.

A certificate field's **colour** lives in its /DA string, which pdf-lib's
appearance provider reads back (`getDefaultColor`) and preserves through
`updateAppearances(font)` at issuance. That is the only reason light text
survives all the way to the issued PDF. `setFontSize` splices just the `Tf`
operator, so the two do not fight.

> Poppler reports `Invalid XRef entry` on an issued certificate from **either**
> template — pdf-lib's flatten leaves stale xref entries behind. Cosmetic: the
> file renders correctly everywhere it has been opened, and it predates the
> dark template.

### 🔴 Two ways NOT to shrink a certificate

Both were tried on 2026-11-17, both produced a **valid PDF whose text layer is
perfect and whose glyphs are missing**, and both passed the entire test suite.

**1. `embedFont(bytes, { subset: true })` at issuance.** 1.25 MB → 277 KB, and
the Inter fields come out shredded: "Lead Installer Certification" renders as
`a  all r C r f ca`, "17 November 2026" as `6`, the serial as nothing. Allura
(the name) is fine. The appearances are built by `updateAppearances` and then
flattened, which evidently does not register those glyphs with pdf-lib's
subsetter the way `drawText` does.

**2. Pre-subsetting the font FILES with `pyftsubset` (Latin + Latin-Ext) and
embedding those whole.** Inter 325 KB → 98 KB, issued file 458 KB, and almost
everything renders — but the hyphen's advance is wrong, so `SU-3344-5566`
prints as `SU-  3344-  5566`. The same class of fault as the Great Vibes `é`.

> ⚠️ **Neither is detectable from the text layer.** `pdfjs.getTextContent()`
> returns the right string, at the right width, for a page that draws nothing —
> so a test that extracts text or measures item widths passes. Both failures
> were found by **rasterising** (poppler and macOS CoreGraphics agree) and
> looking. Any future attempt has to be checked the same way; there is no
> canvas in this project, so it cannot be automated here.

What did work was the template no longer embedding faces it never draws with
(see the dark generator's "Fonts: deliberately none"): 1.25 MB → 843 KB, with
no change to the rendered output at all.

### Design

The artwork is a supplied base plate, **`assets/certificate-base.png`** —
green corner wedges, gold frame, gold seal and a guilloche ground. It is drawn
full-bleed and everything else is typeset on top of it.

> 🔴 **Do not try to redraw that plate.** Three separate attempts at
> reproducing the guilloche in code all came out as random scribble rather
> than the plate's even swoops. It is a plotted pattern; it belongs as an
> image.

The layout is pinned to the plate's own geometry, measured off the image
rather than guessed (points, A4 landscape 842 × 595):

| Feature | Where |
|---|---|
| Top-right wedge | a shallow triangle, (460, 595) → (842, 515) |
| Gold seal | a disc, x 655–790, y 465–581, centre **(722, 523)** |
| Bottom-left wedge | a triangle, (0, 85) → (395, 0) |

Measure the seal by scanning columns for the disc's longest gold run, not by
eye off a grid — reading it off a grid put the centre 5pt high, which is
visible once text is sitting in it.

So the clear column for type is roughly x 60–790, y 100–500, and the foot must
stay above y ≈ 100. `assets/certificate-base.png` is the plate at ~200 dpi; the
original supplied file was 1492 × 1054.

The body reads: name, rule, *has successfully completed all requirements for*,
the training, *issued by Solve University*. The foot is the date on the left
and a signature rule on the right with **Kane Hammontree, CEO** under it, the
space above deliberately empty for a signature.

The plate's seal is left **blank**, as supplied — Torin's call. Its measured
centre is kept in the table above in case anything is ever set into it.

The top-left mark is **`assets/solveu-wordmark.png`**, the portal's own SOLVE-U
logo recoloured dark. The shipped `solve_logo.png` is near-white for the
portal's dark theme (mean RGB 250, 253, 235) and is invisible on the
certificate's paper; the dark copy keeps the same letterforms and alpha and
only repaints the colour, so it stays the same mark.

**The plate is stock artwork.** Recolouring it did not create a licence —
confirm it is licensed for commercial use before certificates go out.

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
2. Webhook and quiz-regeneration endpoints (`/api/webhook/notion*`, `/api/regenerate-quiz/:id`, `/api/regenerate-missing-quizzes`, `/api/webhook/signature-fields`) are unauthenticated: known, not yet fixed. (`/api/debug/user` is protected by `DEBUG_KEY`.)
   - **Static files are now an explicit list** (fixed Nov 2026; before that `express.static(__dirname)` published `server.js`, `CLAUDE.md`, `package.json`, `assets/` and the rest of the project folder). The server serves only `css/`, `js/` and `PUBLIC_ROOT_FILES` in `server.js` (`index.html`, `solve_logo.png`, `solve_icon.png`, `pwa_download.png`, `favicon.ico`) plus the `sw.js` / `manifest.json` routes. **If the browser needs a new file at the project root, add it to `PUBLIC_ROOT_FILES`; if it lives in `css/` or `js/` it just works.** Unknown `/api/*` paths, anything with a file extension and any dot-path (`/.env`, `/.git/...`) return a real 404 instead of the app page.
3. Every employee's default password is the hard-coded string in `/api/login` until they change it; the portal forces a change on first login.
4. **An issued certificate is ~840 KB** (was 1.25 MB until the dark template stopped embedding fonts it never draws with). The rest is the plate, ~263 KB, and the Allura and Inter faces embedded whole. It is downloaded in full for every thumbnail on the main page, so shrinking it further is worth something — but see "Two ways NOT to shrink a certificate" below before trying.
