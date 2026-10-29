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

## Project Structure
```
solve-training-app/
├── server.js          # Express backend — all API endpoints, Notion integration
├── index.html         # Single-page frontend shell
├── js/
│   ├── app.js         # All frontend logic
│   └── tour.js        # First-login welcome screen + guided tour (window.SolveTour)
├── css/
│   └── styles.css     # Dark theme (default) + light theme (body.logged-in)
├── uploads/           # Temp multer upload dir (ephemeral on Railway)
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
- **Training Block**: has `Name`, `Type` (multi-select), `Ordering` (number, optional), `Training link` (url), `Pipeline Stages` (relation), `Notes`, `Policy No.`
- **Training Record**: links Employee + Training Block, has `Date Completed`, `Certificates` (files), `Status`
- **Company Directory**: employees with `Roles`, `Ordered Onboarding Stage`, `Contractor Pages`, `Dealer Organizations`
- **HR Documents**: `Name`, `Person` (relation to directory), `Files & media`, `Type` (select)

## Training Block Types (multi-select field called "Type")
Detected via normalised string matching in `app.js`:
- `"Document Upload"` → `isDocumentUploadBlock()` — uploads to training record Certificates
- `"HR Document Upload"` → `isHRDocumentUploadBlock()` — uploads to HR Documents DB
- `"Signature Required"` → `isSignatureBlock()` — PDF e-signature flow
- All others → quiz-based training (AI-generated quizzes stored in trainingBlockQuizzes DB)
- `"General Resource"` → `hasGeneralResourceTag()` / `isResourceOnlyBlock()` in `server.js`. The block's **Guidance**, **Associated forms** and **Files & media** files, plus its **Training link**, are listed in a "Documents" grid on its role's card on the main page (loaded through `POST /api/resource-files`, rendered by `loadRoleResources()` in `app.js`). Combine it with other tags and the block is still a training AND appears in the grid. In practice each role has two **General Resource-only** blocks: `<Role> Path` and `<Handbook name> (complete)` (the whole handbook as one PDF), both linked to the role's Training Profile(s). A block whose **only** tag is General Resource is not a training: it is removed from `blocks`, the role's `blockIds`, the completion counts and "Other Assigned Trainings", and `regenerateQuizForBlock` skips it, so it just gets a tile on the main page.

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

**⚠️ Certificate uploads (`/api/upload-certificate`) still use external Railway URLs — this is a known issue and should be migrated to the same Notion native upload flow.**

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
| POST | `/api/resource-files` | `{ blockIds }` → files (Guidance / Associated forms / Files & media) and Training link for General Resource blocks (cached 20 min server-side) |

## CSS Theming
- Default (pre-login): dark theme, CSS vars set in `:root`
- Post-login: `body.logged-in` class applied — light theme, vars overridden in `body.logged-in { ... }`
- Higher specificity (`body.logged-in .some-class`) overrides base dark-mode rules
- **Inline styles in `index.html` `<style>` tag** are used for some components to avoid CSS file caching/deployment issues (e.g. `.block-guidance-blurb`)

## notionFetch Helper
```js
async function notionFetch(endpoint, method = 'GET', body = null)
// Uses NOTION_TOKEN, Notion-Version: 2022-06-28, Content-Type: application/json
// For file upload endpoints, use direct fetch() with Notion-Version: 2026-03-11
```

## Known Issues / Pending Work
1. **Certificate uploads still use external URLs** — `POST /api/upload-certificate` stores files as `http://APP_URL/uploads/...`. Should be migrated to `uploadFileToNotion()` like HR docs.
2. **Signed PDF URLs** — `POST /api/sign-document` also stores signed PDFs as external Railway URLs. Same migration needed.
3. Railway's filesystem is ephemeral — uploaded files in `/uploads/` are lost on redeploy.
