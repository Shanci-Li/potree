# Potree project service

Node 18 ESM service and CLI behind the project portal (`projects/index.html`). It serves the project
registry and project metadata, creates new projects (PotreeConverter + imports into the unified
`projects/<id>/` layout), regenerates project pages and previews, and lets the portal browse server
paths. The shared contract is in `projects/README.md` (layout, `project.json` schema).

```
server/
├── project-server.mjs     HTTP API (express), default 127.0.0.1:8090
├── cli.mjs                command-line interface (same library code)
├── templates/project.html page template ({{TITLE}}, {{DESCRIPTION}}, {{PROJECT_ID}})
└── lib/
    ├── config.mjs         environment configuration
    ├── registry.mjs       project discovery, stats, projects/registry.json
    ├── create.mjs         CreateRequest validation and the create / preview jobs
    ├── converter.mjs      PotreeConverter runner + progress parser
    ├── jobs.mjs           persisted single-worker FIFO job queue, single-instance lock
    ├── preview.mjs        headless Chromium preview renderer (+ static server)
    ├── page.mjs           index.html generator
    ├── projects.mjs       PATCH of metadata, on-disk validation
    ├── browse.mjs         /api/fs/list and /api/fs/inspect (LAS headers, 360° coordinates, gpkg)
    ├── requests.mjs       request normalisation (metadata, viewer, material, view)
    ├── crs.mjs            access to projects/shared/crs.js, proj4 validation
    ├── fsutil.mjs         ALLOWED_ROOTS checks, tree copy/scan, log tails
    └── util.mjs           small helpers (errors, slugs, atomic writes)
```

Dependencies come from the repository's root `node_modules` (express, playwright with its Chromium,
proj4). Node 18.19+ is required (`fs.statfs`).

## Running

```sh
API_TOKEN=$(openssl rand -hex 32) node server/project-server.mjs   # API on http://127.0.0.1:8090
node server/cli.mjs help
```

In production nginx proxies `/api/` to the service and systemd runs it (see `deploy/`). Without
`PREVIEW_BASE_URL` the service also serves `POTREE_ROOT` statically on its own port (dot folders such as
`projects/.jobs` are denied) so the preview renderer can load project pages; keep `HOST` on localhost.

**One service per `PROJECTS_DIR`.** On start the service takes the lock `PROJECTS_DIR/.jobs/server.lock`
(pid, host, boot id and process start time) *before* it touches anything, then binds its port, and only
then recovers the jobs of its previous run (marks them failed and deletes their staging folders). A second
instance on the same `PROJECTS_DIR` — whatever its `PORT` — exits with "another project service (pid N)
is using …" without touching jobs or staging folders. A lock left by a crashed process (dead pid, pid
reused by another process, or written before a reboot) is replaced automatically; the lock is removed on
shutdown. `node server/cli.mjs create` refuses to run while the service holds the lock. To run a second
(development) instance, give it its own `PORT` **and** its own `PROJECTS_DIR` (with `shared/` and
`portal/` copied from `projects/`; it must lie inside `POTREE_ROOT` for previews), e.g.
`PORT=18090 PROJECTS_DIR=/mnt/Data2/potree/projects-dev API_TOKEN=dev-token-0123456789 node server/project-server.mjs`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | listen address |
| `PORT` | `8090` | listen port |
| `POTREE_ROOT` | `/mnt/Data2/potree` | repository root (served at `/`) |
| `PROJECTS_DIR` | `$POTREE_ROOT/projects` | project folders, `registry.json`, `.staging/`, `.jobs/` |
| `POTREE_CONVERTER` | `/mnt/Data2/PotreeConverter/build/PotreeConverter` | PotreeConverter 2.x binary |
| `ALLOWED_ROOTS` | `/mnt/Data2` | colon-separated roots; every user-supplied path must resolve (realpath) inside one |
| `API_TOKEN` | unset | shared secret required by the protected API endpoints (see *Authentication*); unset = those endpoints answer 503 |
| `MOVE_ROOTS` | unset (empty) | colon-separated absolute folders below which `importMode: "move"` is allowed; empty = move disabled (missing folders are ignored with a warning) |
| `PREVIEW_BASE_URL` | unset | base URL serving `POTREE_ROOT` for the renderer (e.g. `http://127.0.0.1:8080`); unset = this service |

## CLI

```
node server/cli.mjs registry                      rebuild projects/registry.json
node server/cli.mjs page <id> | --all             regenerate index.html (non-custom projects only)
node server/cli.mjs preview <id> | --all [--force] render preview.jpg (missing/outdated only unless --force)
node server/cli.mjs create <request.json>         create a project from a CreateRequest file, in the foreground
node server/cli.mjs validate [<id>]               check project.json and every relative URL it references
```

The CLI starts its own temporary static server on 127.0.0.1 for previews unless `PREVIEW_BASE_URL` is set.
`validate` exits with code 1 when a referenced file is missing (broken symlinks included); URLs that
resolve outside the project folder (but inside `POTREE_ROOT`) are reported as warnings.

## HTTP API (prefix `/api`, JSON)

Errors are `{error, details?}` with status 400 (invalid request), 401 (token missing or wrong),
403 (path outside `ALLOWED_ROOTS`), 404, 409 (project id in use, or a project changed since it was read),
429 (too many inspections at once), 503 (service starting, no `API_TOKEN` configured, converter or CRS
table unavailable) or 500.

### Authentication

Open to everyone (read-only): `GET /health`, `GET /projects`, `GET /projects/:id`, `GET /crs`. Every
other request — all `POST`/`PATCH`/`PUT`/`DELETE`, `GET /fs/*` (server file browser) and `GET /jobs`,
`GET /jobs/:id` — needs the token from `API_TOKEN`, sent as `Authorization: Bearer <token>` or
`X-Api-Token: <token>` (compared in constant time).

* no or wrong token → `401 {"error":"authentication required","auth":"token"}` (+ `WWW-Authenticate: Bearer`);
* `API_TOKEN` not set → `503 {"error":"project service has no API_TOKEN configured; creating and editing
  projects is disabled","auth":"unconfigured"}` — secure by default;
* `/health` reports `auth: {required: true, configured: <bool>}` so the portal can tell the two apart.

The CLI works on the files directly and needs no token. Generate a token with `openssl rand -hex 32`.

| Method | Path | Result |
|---|---|---|
| GET | `/health` | `{ok, version, converter:{path, exists}, preview:{available, reason?, baseUrl}, queue:{running, queued, current}, auth:{required, configured}, importModes, moveRoots}`; `importModes` is `["copy","symlink"]` plus `"move"` when `MOVE_ROOTS` is set |
| GET | `/projects` | registry object (same shape as `projects/registry.json`), built on request |
| GET | `/projects/:id` | the project's `project.json` |
| POST | `/projects` | body = CreateRequest → `202 {jobId, projectId}` |
| PATCH | `/projects/:id` | body with any of `title, description, keywords, location, date, source` → updated `project.json`; bumps `updatedAt`, regenerates the page (non-custom) and the registry. Problems doing so are reported in an `X-Warnings` header. Optional `expectedUpdatedAt` (the `updatedAt` last read): if the project changed since, nothing is written → `409` with `details.updatedAt`. Updates of one project are serialised, so concurrent partial PATCHes never lose fields |
| POST | `/projects/:id/preview` | re-render the preview → `202 {jobId}` |
| GET | `/jobs` | array of job summaries, newest first (`{id, type, projectId, status, progress, currentStep, error, createdAt, startedAt, finishedAt}`) |
| GET | `/jobs/:id` | `{id, type, projectId, status, progress, steps[], log[], error, result, warnings[], ...}` |
| GET | `/fs/list?path=&ext=&q=` | `{path, parent, roots, q, entries:[{name, path, type:"dir"|"file", size, mtime}], truncated, total}`; directories first, hidden entries skipped, `ext=las,laz` filters files, `q` keeps entries whose name contains it (case-insensitive). Both filters apply before the 500-entry cap; `total` counts the matching entries and `truncated` is `total > entries.length` |
| GET | `/fs/inspect?path=&kind=` | `kind` ∈ `pointcloud`, `images360` (optional `coordinatesFile=`), `labels`, `vector` → `{ok, path, type, size, summary, warnings[]}`; `summary.text` is a one-line description. Limits: at most 3 inspections run at once (20 more wait, then 429); a label-folder scan stops after 200,000 files or 10 s (`summary.truncated`, counts are lower bounds); the work stops when the client disconnects; a coordinates file must be a regular file of at most 64 MB inside `ALLOWED_ROOTS`; for more than 1,000 LAS/LAZ files only 1,000 headers are read and `points`/`estimatedOutputBytes` are extrapolated (`pointsPartial`, `estimatedPartial`) |
| GET | `/crs` | `[{name, title, proj4}]` from `projects/shared/crs.js` |

Jobs: `status` ∈ `queued | running | succeeded | failed`; each step is `{key, label, weight, status:
pending|running|succeeded|failed|skipped, progress, startedAt, endedAt, detail}`; `log` holds the last 300
lines. Create steps: `validate, convert, images360, labels, vectors, project, page, finalize, preview,
registry`. A failed `preview` step does not fail the job (the project exists; the failure is listed in
`warnings`).

Progress semantics:

* `steps[].progress` is a **fraction 0–1** of that step (0 when pending, 1 when succeeded; a failed step
  keeps the fraction it had reached). Display it as `Math.round(progress * 100) + "%"`.
* the job's `progress` is a **percentage 0–100** (one decimal): the weighted share of the work done over
  the steps that apply (skipped steps are left out); succeeded steps count fully, running and failed steps
  with the fraction they reached. A succeeded job is 100; a failed job keeps the share it had reached
  (a create that fails at the start of the conversion is ≈ 3 %, not 92 %).

Jobs are persisted in `projects/.jobs/<id>.json` + `.log`; the state writes of a job are serialised (the
file always holds the newest state, and the job's `persist()` returns only once it is on disk). Jobs that
were queued or running when the service stopped are marked failed ("interrupted by server restart") on
the next start and their staging folder is removed (unless data was moved into it).

Project ids are reserved when the job is queued: of two simultaneous creates for the same id, the second
gets 409 (requested id) or the next free suffix (id derived from the title), never a second 202 for the
same id.

### CreateRequest

```jsonc
{
  "id": "optional-slug",                 // default: derived from the title, made unique
  "title": "required", "description": "", "keywords": [], "location": "", "date": "", "source": "", "notes": "",
  "pointcloud": { "path": "/mnt/Data2/.../in.laz or folder", "crs": "EPSG:2056", "proj4": "optional custom def" },
  "conversion": { "encoding": "DEFAULT" | "BROTLI", "method": "poisson" | "poisson_average" | "random" },
  "images360": { "path": "/.../pano", "coordinatesFile": "coordinates.txt", "crs": null } | null,
  "labelSets": [ { "name": "Cityscapes", "id": "optional", "path": "/.../label_cityscape" } ],
  "vectors": [ { "path": "/.../a.gpkg", "name": "optional", "crs": null, "visible": true } ],
  "importMode": "copy" | "symlink" | "move",   // default "copy"
  "viewer":   { "pointBudget": 2000000, "classificationScheme": null, "controls": "earth", "edl": true, "fov": 60 },
  "material": { "activeAttribute": "rgba", "gradient": null, "size": 0.7, "pointSizeType": "ADAPTIVE", "shape": "SQUARE" },
  "view": null,                            // or {position:[x,y,z], target:[x,y,z]}
  "previewView": null,                     // optional, same shape, used only for preview.jpg (computed for
                                           // projects with 360° images when neither view is given)
  "renderPreview": true
}
```

* **Point cloud**: one `.las`/`.laz` file, or a folder whose `.las`/`.laz` files *directly inside* it are
  converted (PotreeConverter does not search subfolders). `crs` is a name from `/api/crs` (`"2056"` is
  accepted as `EPSG:2056`), `"local"` or null; `proj4` gives a custom definition, stored in `crsDefs` under
  `crs` (default name `CUSTOM`). The definition is written to `metadata.json` "projection" via
  `--projection`.
* **Layer CRS** (`images360.crs`, `vectors[].crs`): null = same as the point cloud, otherwise a known name.
* **360° coordinates file**: a regular file of at most 64 MB whose real path lies inside `ALLOWED_ROOTS`.
* **Imports** go to `images360/`, `labels/<id>/` and `vectors/<file>.gpkg` (names deduplicated).
  `importMode` must be one of the `importModes` of `/api/health`:
  * `copy` copies the tree, never overwriting; symlinks inside it are followed only when their real path
    stays inside `ALLOWED_ROOTS` (others are skipped and logged); copies are made world-readable so nginx
    can serve them.
  * `symlink` creates an absolute symlink to the source.
  * `move` renames the source into the project. It is only available when `MOVE_ROOTS` is set, and is
    refused unless the source's real path lies strictly inside one of those folders and was not reached
    through a symlink; also refused for anything inside, equal to or containing `POTREE_ROOT`, the
    PotreeConverter or the server folder, the target of an existing project's symlink, overlapping sources
    and other filesystems (all checked up front; `EXDEV` is still reported clearly).
* **Pipeline**: everything is assembled in `projects/.staging/<id>/` and renamed to `projects/<id>/`
  when complete. On failure the staging folder is deleted (symlinks are removed, never followed) unless
  something was moved into it; then it is kept and the error names it and the moved sources.
* The validate step checks LAS headers, 360° coordinates (all rows up to 20,000, else a sample; missing
  images and positions outside the point cloud are warnings), label files for a sample of images,
  GeoPackage signatures and free disk space (≈1.5 × points × record length + copied bytes; for more than
  1,000 LAS/LAZ files the point count is extrapolated from the headers read).
* If the cloud has no RGB, `activeAttribute: "rgba"` is replaced by `elevation` (with a warning).

## Previews

`lib/preview.mjs` launches Playwright Chromium (GPU WebGL first, SwiftShader fallback), opens
`<base>/projects/<id>/<entry>?preview=1` at 1280×720 and waits for `window.__projectReady` (150 s;
`window.__projectError` fails the render). Custom projects (`"custom": true`) get the load event plus
20 s. The screenshot (JPEG, quality 85) replaces `preview.jpg` atomically. Page console errors go to the
job log. One browser is reused for consecutive renders and closed when the queue is idle.
