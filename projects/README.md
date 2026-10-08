# Private Potree projects

Everything that belongs to a private project lives in **one folder** `projects/<id>/`.
`examples/` and `pointclouds/` only contain the official Potree examples and their sample data.

Served at `http://<host>:8080/projects/` — the portal (`index.html`) lists every project with a
preview, key facts and keywords, and can create new projects through the project service
(`server/`, see `deploy/README.md`).

## Layout

```
projects/
├── index.html            project portal (gallery + "New project" wizard)
├── portal/               portal assets (portal.css, portal.js)
├── shared/               runtime shared by all generated project pages
│   ├── project-viewer.js   loadProject(viewer, "./project.json") — builds the scene from project.json
│   ├── image-search.js     "Find image" box over the panoramas / oriented photos (also used by autoinspect)
│   └── crs.js              built-in CRS table (proj4 definitions), also used by the server
├── registry.json         generated summary of all projects (portal reads it; do not edit by hand)
├── .staging/ .jobs/      work folders of the project service (hidden from the web server)
└── <id>/                 one folder per project; id = lowercase letters, digits and dashes
    ├── index.html        viewer page — generated from server/templates/project.html
    ├── project.json      manifest: metadata, data paths, viewer settings (single source of truth)
    ├── preview.jpg       1280×720 preview rendered headless from the page
    ├── pointcloud/       PotreeConverter 2.x output (metadata.json, hierarchy.bin, octree.bin, log.txt)
    ├── pointcloud-<x>/   further point clouds of the same project (e.g. pointcloud-prediction/)
    ├── images360/        coordinates.txt + panoramas (File column relative to this folder)
    ├── labels/<set>/     one folder per label set, same file names as images360/
    ├── vectors/          GeoPackages (*.gpkg), optionally with a layers.json lazy manifest
    └── extras/           anything else (trajectories, unused or older files)
```

`autoinspect/` is a hand-written app (`"custom": true`) that keeps its own layout
(`libs/`, `pointclouds/index`, `pointclouds/classes/<class>`, `images/`); it is listed in the portal
but its page is never regenerated.

## Current projects

| id | content |
|---|---|
| `arolla` | power-line drone LiDAR tile t1z4 — ground-truth and prediction point clouds (prediction unticked) + GT / predicted vectors |
| `grandson` | power-line tile t3z1 — ground-truth and prediction point clouds + GT, RANSAC GT and predicted vectors |
| `valais` | power-line tile in true colour with demo vectors |
| `autoinspect` | custom inspection app (class sub-clouds, oriented DJI photos, camera flight) |
| `neuchatel` | mobile LiDAR + 2,337 panoramas + Cityscapes labels |
| `ollon-idw` | mobile LiDAR with IDW-transferred labels + 6,173 panoramas with **two switchable label sets** |
| `streetview-ne` | 5.2 B-point road network + 10,838 panoramas + manhole-cover ground truth |
| `vevey` | mobile LiDAR + 14,209 panoramas + Cityscapes labels + lazily loaded SAM3 detections |
| `neocapture-voiteur` | Trimble MX50 acquisition (Lambert-93) + panoramas; vectors/mesh streamed from object storage |

## project.json

Relative URLs are resolved against the project folder; absolute `https://` URLs are allowed.

```jsonc
{
  "schemaVersion": 1,
  "id": "ollon-idw",
  "title": "…", "description": "…", "keywords": ["…"],
  "location": "…", "date": "…", "source": "…",          // optional
  "entry": "index.html", "preview": "preview.jpg",
  "custom": false,                                      // true = hand-written page, never regenerated
  "crs": "EPSG:2056",                                   // CRS of the point cloud ("local" if unreferenced)
  "crsDefs": { "EPSG:xxxx": "+proj=…" },                // optional extra proj4 definitions
  "pointclouds": [{                                     // several entries = several clouds in one project
    "name": "ollon", "url": "pointcloud/metadata.json",
    "visible": true,                                    // false = listed unticked in the scene tree
    "material": {
      "activeAttribute": "img_label", "gradient": "CITYSCAPE",
      "size": 0.5, "minSize": 2, "pointSizeType": "ADAPTIVE", "shape": "SQUARE",
      "ranges": { "img_label": [0, 19] },               // fixed value ranges per attribute
      "gradients": { "img_label": "CITYSCAPE" }         // gradient applied when the attribute is selected
    }
  }],
  "viewer": { "pointBudget": 2000000, "fov": 60, "edl": true, "controls": "earth",
              "classificationScheme": "MAGIC3D", "openMenus": ["appearance"], "sidebar": true,
              "description": "HTML shown in the sidebar" },
  "view": { "position": [x, y, z], "target": [x, y, z] },        // or null = fit to screen
  "previewView": { "position": [x, y, z], "target": [x, y, z] }, // optional: camera for preview.jpg only
  "images360": {
    "url": "images360", "coordinatesFile": "coordinates.txt", "crs": null,
    "labelSets": [ { "id": "cityscape", "name": "Cityscapes",       "url": "labels/cityscape" },
                   { "id": "sam",       "name": "Cityscapes + SAM", "url": "labels/sam" } ]
  },
  "vectors": [
    { "name": "Wall polygons", "url": "vectors/wall_polygons.gpkg", "crs": null, "visible": true },
    { "name": "Detections", "manifest": "vectors/detections/layers.json", "lazy": true }
  ],
  "meshes": [ { "name": "Road surface", "url": "…/road_surface.ply", "format": "ply",
                "crs": null, "color": "#4488cc", "opacity": 0.7 } ]
}
```

A layer `crs` of `null` means "same CRS as the point cloud" (identity transform).

`previewView` matters for long mobile-mapping surveys: fitted to the whole network they show up as a
thin line in the 1280×720 preview. The project service sets it automatically for new projects with
panoramas (an oblique close-up of the densest panorama area that lies on the point cloud).

## 360° images and label sets

`images360/coordinates.txt` is tab-separated with a header:
`File  Time  x  y  z  course  pitch  roll`. Each label set folder mirrors the `File` paths.
In the viewer, click a sphere to enter the panorama; the bar at the bottom right switches between
the photo and each label set (`l` cycles, double-click also cycles) and steps to the previous/next
panorama (`[` / `]`). The chosen label set stays active when you move to other panoramas.
The *Point cloud* slider in the same bar blends the point cloud over the panorama (0 % = panorama
only); it applies only while a panorama is on screen and is disabled while the 360° set is unticked.

The *Find image* box (top left, `/` focuses it) searches the panoramas and oriented photos by file
name, frame number, or a pasted or cut-off path or URL. Enter flies to a clear view of the image and
flashes its marker; a second Enter opens it.

## Adding a project

* **Portal** — *New project*: point-cloud path (LAS/LAZ file or folder) + CRS, optional panorama
  folder, label-set folders and GeoPackages, import mode (copy / symlink; move only where the
  administrator enabled it with `MOVE_ROOTS`) and viewer defaults. The service runs PotreeConverter,
  assembles `projects/<id>/`, writes `project.json`, generates `index.html`, renders `preview.jpg`
  and updates `registry.json`. Creating and editing ask once for the service's access token
  (`API_TOKEN`, see `deploy/README.md`); browsing the portal does not.
* **CLI** (same pipeline, no token, only while the service is stopped):
  `node server/cli.mjs create request.json` — see `server/README.md`.

After editing a `project.json` by hand:

```bash
node server/cli.mjs page <id>        # regenerate index.html (non-custom projects)
node server/cli.mjs preview <id>     # re-render preview.jpg
node server/cli.mjs registry         # refresh registry.json for the portal
```

## History

The 2026-10-07 reorganisation moved data out of `pointclouds/` and `examples/`; every move is
logged in `archive/migration-2026-10-07.tsv` (reversible). The same day `arolla-prediction` and
`grandson-prediction` were merged into `arolla` and `grandson` (`archive/merge-2026-10-07.tsv`). The superseded hand-written pages are kept
in `archive/legacy-pages/` for reference. `nearai-seg/pipeline_vevey` (`deploy.sh`,
`publish_to_potree.py`) publishes the SAM3 detections straight into `projects/vevey/vectors/detections`
and keeps its `layers.json` up to date; the viewer picks new files up from that manifest.
