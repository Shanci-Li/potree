# Deployment: nginx site + project service

This folder holds the server configuration for the Potree viewer, the project
portal and the project service on this host. Nothing in it is served over
HTTP: nginx returns 404 for `/deploy/`.

| File | Installed as | Purpose |
|---|---|---|
| `nginx/potree.conf` | `/etc/nginx/sites-available/potree` (already symlinked from `sites-enabled/`) | Static site on **:8080** (root `/mnt/Data2/potree`; :8081 only redirects to :8080), `/api/` reverse proxy, redirects from legacy URLs, caching, gzip, access rules |
| `systemd/potree-projects.service` | `/etc/systemd/system/potree-projects.service` | Runs `server/project-server.mjs` (HTTP API on `127.0.0.1:8090`) as `sliadmin` |
| n/a (created by hand) | `/etc/potree-projects.env` (root only, mode 600) | Site settings and secrets of the service: `API_TOKEN`, `MOVE_ROOTS`, optional `ALLOWED_ROOTS` |
| `README.md` | n/a | This file |

The other sites on this host (`default` on :80 and `vaud-soil` on :80) are not
affected. The new file only replaces the old `potree` server block.

## URL map (port 8080)

The site moved from :8081 to :8080 on 2026-10-07 (8080 used to be a stand-alone dev
`http-server`). :8081 now answers every request with a 301 to the same URL on :8080; delete
the last `server` block of `nginx/potree.conf` once nobody uses :8081 links any more.

| URL | Served from / behaviour |
|---|---|
| `/` | `302` redirect to `/projects/` |
| `/projects/` | project portal `projects/index.html` |
| `/projects/<id>/` | project viewer page `projects/<id>/index.html` |
| `/projects/<id>/pointcloud/…`, `images360/…`, … | project data. Range requests work, and folders can be browsed (autoindex) |
| `/projects/shared/…`, `/projects/portal/…` | runtime of the project pages and of the portal (always revalidated) |
| `/examples/` or `/examples/page.html` | official Potree examples page |
| `/build/…`, `/libs/…` | Potree build and third-party libraries (cached 1 h) |
| `/pointclouds/…` | official example data |
| `/api/…` | proxied to `http://127.0.0.1:8090/api/…` (project service, see [Access control](#access-control)) |
| `/.*` (any dot-path: `.git`, `.vscode`, `projects/.staging`, `projects/.jobs`, …), `/server/`, `/deploy/`, `/archive/`, `/node_modules/` | `404` |

**Legacy redirects (301).** The query string is kept. Map keys are matched
case-insensitively.

| Old URL | New URL |
|---|---|
| `/projects/Arolla.html`, `/examples/Arolla.html`, `/projects/Arolla_prediction.html`, `/examples/Arolla_prediction.html` | `/projects/arolla/` |
| `/projects/Grandsons.html`, `/projects/Grandsons_ransac.html`, `/examples/Grandsons.html`, `/examples/Grandsons_ransac.html` | `/projects/grandson/` |
| `/projects/Grandsons_prediction.html`, `/examples/Grandsons_prediction.html` | `/projects/grandson/` |
| `/projects/neuchatel.html` | `/projects/neuchatel/` |
| `/projects/ollon_idw.html` | `/projects/ollon-idw/` |
| `/projects/streetview_ne.html` | `/projects/streetview-ne/` |
| `/projects/valais.html` | `/projects/valais/` |
| `/projects/vevey.html`, `/examples/vevey.html` | `/projects/vevey/` |
| `/projects/NeoCapture.html`, `/projects/NeoCapture%20copy.html` | `/projects/neocapture-voiteur/` |
| `/examples/autoinspect/DJI_*.JPG`, `…/camerat1z8.txt`, `…/ParamCam.xml`, `…/cam_t1z8_xml.xml` | `/projects/autoinspect/images/<file>` |
| `/examples/autoinspect/<path>` (everything else) | `/projects/autoinspect/<path>` |
| `/examples/Potree_conv/<path>` | `/projects/autoinspect/pointclouds/classes/<path>` |
| `/projects/arolla-prediction[/<path>]`, `/projects/grandson-prediction[/<path>]` | `/projects/arolla/`, `/projects/grandson/` (merged on 2026-10-07; the prediction is a second, initially hidden point cloud) |

The pages that these URLs used to serve are kept in `archive/legacy-pages/`.

### What changed compared with the old site

* `index index.html page.html` replaces `index examples/page.html`, so every
  folder that has an `index.html` (the portal and the project pages) opens it.
* The old `error_page 404 ./examples/page.html` is gone. It answered missing
  files (for example a missing `octree.bin`) with an HTML page and status 200,
  which hid the real error from Potree. Missing files now return a real 404.
* Redirects use relative `Location` headers (`absolute_redirect off`), so they
  also work through SSH tunnels and port forwards.
* **Caching:**
  * `*.html` (the portal, every `projects/<id>/index.html`, also when opened
    as `/projects/<id>/`), `*.json` (`project.json`, `registry.json`,
    `metadata.json`, `layers.json`, …), `hierarchy.bin` and `octree.bin` are
    sent with `Cache-Control: no-cache`. The browser keeps its copy but
    revalidates it every time (a cheap `304`). Point clouds can be regenerated
    in place, and a stale `octree.bin` combined with a new `hierarchy.bin`
    would render garbage, so these files never get long or immutable caching.
  * Everything under `projects/shared/` (`project-viewer.js`, `crs.js`) and
    `projects/portal/` (the portal's JS modules and `portal.css`) is also sent
    with `no-cache`. These modules are imported by unversioned URLs, so a
    heuristically cached old copy could otherwise keep running for days
    against a fresh `project.json` or a newer `/api/`.
  * `build/` and `libs/` are cached for one hour. After rebuilding Potree
    (`build/potree/potree.js`), a visitor can run the previous build for up to
    an hour; a hard reload (Ctrl+Shift+R) picks up the new one at once.
  * Panoramas, labels and other data use the browser's default caching, based
    on `Last-Modified` and `ETag`.
* **gzip** is applied to text types only: html, css, js, json, svg, xml and
  `text/plain` (`coordinates.txt`). Binary data is never compressed, so Range
  requests on `octree.bin` keep working (`206`).
* nginx logs for this site now go to separate files:
  `/var/log/nginx/potree.access.log` and `/var/log/nginx/potree.error.log`.
  The existing logrotate rule for `/var/log/nginx/*.log` covers them.
* `/api/` is the new project service. Read [Access control](#access-control)
  before you enable it.

## Access control

Through `/api/`, the project service can browse every folder under
`ALLOWED_ROOTS`, run PotreeConverter, and **copy or symlink any folder or file
under `ALLOWED_ROOTS` into `projects/<id>/`**, which nginx publishes to
everyone who can reach :8080 (folders are listed, symlinks are followed). If
`MOVE_ROOTS` is set it can also **move** folders out of those roots into a
project. nginx listens on all interfaces of this host (10.190.169.0/24 and
10.180.1.0/24), and the host firewall is off.

The service therefore protects itself with a shared **API token**:

* Open to everyone: `GET /api/health`, `/api/projects`, `/api/projects/<id>`,
  `/api/crs`, so the portal and the project pages work for every visitor.
* Token required: every request that changes something (create, edit,
  re-render preview, …) and `GET /api/fs/*` (folder browser) and
  `/api/jobs…`. Without a valid token the service answers `401`.
* If no `API_TOKEN` is configured, these calls answer `503` and the portal
  keeps creating and editing disabled (secure by default).

The token is sent as `Authorization: Bearer <token>` (or `X-Api-Token:
<token>`). The site runs on plain HTTP, so anyone who can capture traffic
between a browser and this host could read the token. That is acceptable on
the trusted campus networks only; from elsewhere use an SSH tunnel
(`ssh -L 8080:127.0.0.1:8080 <host>`). Change the token if it may have leaked
([Changing the token](#changing-the-token)).

**Optional network allow-list.** `potree.conf` has a commented
`allow … / deny all;` block inside `location ^~ /api/`. Uncomment it to let
only the listed hosts or subnets reach the API at all, on top of the token.
Clients outside the list get `403` from `/api/`; for them the portal falls back
to read-only browsing from `projects/registry.json`. Keep the ranges narrow
(single hosts as `/32`, or one subnet such as `10.190.169.0/24`); `10.0.0.0/8`
covers every network of this host and restricts almost nothing.

### Entering the token in the portal

Give the token to the people who create projects, through a trusted channel.
They open `http://<host>:8080/projects/` and click **New project** (or edit a
project). Before the first protected call, the portal asks for the
**access token** in a small dialog:

* **Remember on this device** (on by default) keeps it in the browser's local
  storage for this site; unticked, it is kept only until the tab is closed.
* If the token is wrong or has been changed on the server, the portal forgets
  it and asks again.
* The header menu has an entry to forget the token (sign out), for example
  on a shared computer.

## Install / update

Run the commands from the repository root (`cd /mnt/Data2/potree`). They need
sudo. Install `server/project-server.mjs` before you enable the service.

### 1. nginx site

```bash
cd /mnt/Data2/potree
# back up the live config (keep the backup in sites-available, NOT sites-enabled)
sudo cp /etc/nginx/sites-available/potree /etc/nginx/sites-available/potree.bak-$(date +%Y%m%d)
# install the new site (sites-enabled/potree is already a symlink to this path)
sudo install -m 644 deploy/nginx/potree.conf /etc/nginx/sites-available/potree
# validate, then reload without downtime (reload only happens if the test passes)
sudo nginx -t && sudo systemctl reload nginx
```

If `nginx -t` fails, nothing has been reloaded. Restore the backup as shown in
[Rollback](#rollback).

### 2. Service settings and API token

The unit reads `/etc/potree-projects.env` (one `NAME=value` per line, `#` for
comments). Keep the token there, not in the unit file: unit files are
world-readable and `systemctl show` prints their `Environment=` lines. Create
the file readable by root only and add a random token:

```bash
sudo install -m 600 /dev/null /etc/potree-projects.env
echo "API_TOKEN=$(openssl rand -hex 24)" | sudo tee -a /etc/potree-projects.env
```

`tee` prints the new line; that value (48 hex characters) is the token you
give to the portal users. To look it up later:
`sudo grep '^API_TOKEN=' /etc/potree-projects.env`.

Optional lines in the same file (see [Settings](#settings)):

```bash
# enable "move" imports, only for sources inside these folders
MOVE_ROOTS=/mnt/Data2/potree-inbox
# narrower list of folders the API may browse and import from
ALLOWED_ROOTS=/mnt/Data2/mobile_mapping:/mnt/Data2/magic3D:/mnt/Data2/Valais:/mnt/Data2/nearai:/mnt/Data2/potree-inbox
```

Edit it with `sudoedit /etc/potree-projects.env`, then
`sudo systemctl restart potree-projects`.

### 3. Project service (systemd)

```bash
cd /mnt/Data2/potree
sudo install -m 644 deploy/systemd/potree-projects.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now potree-projects
systemctl status potree-projects --no-pager
```

### 4. Check

```bash
curl -s  http://127.0.0.1:8090/api/health        # service directly
curl -s  http://127.0.0.1:8080/api/health        # through nginx; "auth":{"required":true,"configured":true}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/jobs                         # 401 (no token)
TOKEN=$(sudo sed -n 's/^API_TOKEN=//p' /etc/potree-projects.env | tail -n 1)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/jobs   # 200
curl -sI http://127.0.0.1:8080/                  # 302, Location: /projects/
curl -sI http://127.0.0.1:8080/projects/vevey.html   # 301, Location: /projects/vevey/
curl -sI http://127.0.0.1:8080/examples/autoinspect/ParamCam.xml   # 301, Location: /projects/autoinspect/images/ParamCam.xml
curl -sI http://127.0.0.1:8080/projects/shared/project-viewer.js | grep -i cache-control   # no-cache
curl -s -o /dev/null -w '%{http_code}\n' -r 0-1023 http://127.0.0.1:8080/projects/arolla/pointcloud/octree.bin  # 206
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/.git/config    # 404
```

## Settings

The unit runs `/usr/bin/node server/project-server.mjs` from
`/mnt/Data2/potree` as `sliadmin:sliadmin`. Values in
`/etc/potree-projects.env` override the `Environment=` lines of the unit.

| Setting | Where | Value |
|---|---|---|
| `HOST` | unit | `127.0.0.1` (only nginx talks to the service) |
| `PORT` | unit | `8090` |
| `POTREE_ROOT` | unit | `/mnt/Data2/potree` |
| `POTREE_CONVERTER` | unit | `/mnt/Data2/PotreeConverter/build/PotreeConverter` |
| `ALLOWED_ROOTS` | unit, override in env file | `/mnt/Data2` (colon-separated). Every path the API browses or imports must lie inside one of them. See below |
| `API_TOKEN` | env file | random secret; required for creating and editing projects (see [Access control](#access-control)) |
| `MOVE_ROOTS` | env file | empty (default): "move" imports are disabled. See below |
| `HOME` | unit | `/home/sliadmin` (Playwright finds Chromium in `~/.cache/ms-playwright`) |
| `UMask` | unit | `0002`, see [File permissions](#file-permissions) |
| `Nice` | unit | `5` |
| `Restart` | unit | `on-failure` |

Hardening is limited to `NoNewPrivileges` and `ProtectSystem=full`, so that
PotreeConverter and headless Chromium (GPU through `/dev/nvidia*`) keep
working.

Restarting or stopping the service also stops any running PotreeConverter or
Chromium child processes. A conversion that is running at that moment fails and
has to be started again.

**Narrow `ALLOWED_ROOTS`.** The default `/mnt/Data2` lets token holders
publish anything on the data disk, including other services' trees (for
example `/mnt/Data2/vaud_soil`) and this repository itself. List only the
folders that hold survey inputs (point clouds, panoramas, labels, GeoPackages),
for example
`ALLOWED_ROOTS=/mnt/Data2/mobile_mapping:/mnt/Data2/magic3D:/mnt/Data2/Valais:/mnt/Data2/nearai`,
or a single drop folder such as `/mnt/Data2/potree-inbox`. Never list
`/mnt/Data2/potree` or another web root. The portal's folder browser then
starts at these roots, and paths outside them are refused with `403`.

**`MOVE_ROOTS` and "move" imports.** Imports are copied by default; "symlink"
links the source instead. "move" renames the source folders into the project
(no copy, no extra disk space) and is disabled unless `MOVE_ROOTS` names one or
more existing folders (colon-separated, absolute; missing ones are ignored with
a warning in the log). Point it at a dedicated drop folder, for example
`mkdir -m 775 /mnt/Data2/potree-inbox` as `sliadmin`. It must also be inside
`ALLOWED_ROOTS`, on the same filesystem as `projects/` (a move is a rename),
and `sliadmin` must be allowed to rename its contents. Even then the service
only moves folders strictly inside a move root (never the root itself), and
refuses sources that were reached through a symlink, that are part of the
Potree site, of PotreeConverter or of the service, or that hold data an
existing project links to. After a restart, `GET /api/health` shows the result
in `importModes` and `moveRoots`.

### File permissions

`UMask=0002` applies to the files the service writes itself (converter output,
`project.json`, pages, previews): files are 664 and folders 775, so nginx
(`www-data`) can read them. Copied imports keep their content but are made
world-readable by the service (files at least 444, folders at least 555).
Moved and symlinked sources keep their own permissions: they, and every folder
above a symlinked source, must be readable by `www-data`, or nginx answers
`403` and the viewer shows missing images or layers. Fix such a case with
`chmod -R o+rX <folder>`.

### Changing settings

To change the unit, edit `deploy/systemd/potree-projects.service`, re-run the
`install` and `daemon-reload` commands above, then run
`sudo systemctl restart potree-projects`. Site-specific values belong in
`/etc/potree-projects.env` (restart afterwards). You can also use
`sudo systemctl edit potree-projects` for a local override.

#### Changing the token

Replace the `API_TOKEN=` line (`sudoedit /etc/potree-projects.env`, value e.g.
from `openssl rand -hex 24`) and run `sudo systemctl restart potree-projects`.
Browsers that remembered the old token get `401`, and the portal asks for the
new one.

## Logs

```bash
sudo journalctl -u potree-projects -f              # service log (follow)
sudo journalctl -u potree-projects --since today   # today's entries
systemctl status potree-projects --no-pager        # state + last lines
sudo tail -f /var/log/nginx/potree.access.log /var/log/nginx/potree.error.log
sudo tail -f /var/log/nginx/error.log              # nginx start/reload errors
```

Each job also keeps its own state and log under `projects/.jobs/`. The API
exposes them at `GET /api/jobs/<id>` (token required).

## Rollback

### Take the project service offline

This is the safe way back. The static site, the project pages and the portal
(read-only, from `projects/registry.json`) keep working; only `/api/` (portal
wizard, project creation, preview rendering) returns `502`.

```bash
sudo systemctl disable --now potree-projects
sudo rm /etc/systemd/system/potree-projects.service
sudo systemctl daemon-reload
```

To also hide `/api/` in nginx, comment out the `location ^~ /api/ { … }` block
in `/etc/nginx/sites-available/potree` and run
`sudo nginx -t && sudo systemctl reload nginx`. Keep the rest of the new
config: it carries the `index index.html` rule, the legacy redirects and the
dot-path deny rules that the new folder layout needs.

### Restoring the old nginx config

Put the backup back (use the date of the backup you made):

```bash
sudo cp /etc/nginx/sites-available/potree.bak-YYYYMMDD /etc/nginx/sites-available/potree
sudo nginx -t && sudo systemctl reload nginx
```

**Caveat:** the backup is the configuration from before the 2026-10-07 folder
migration (`archive/migrate-2026-10-07.sh`), but the data is already in the new
layout. With the old config on its own:

* legacy URLs such as `/projects/vevey.html` are no longer redirected; they
  now miss, and the old relative `error_page 404 ./examples/page.html` turns
  that into an endless chain of `302` redirects;
* `/projects/<id>/` shows a folder listing instead of the viewer (the old
  `index examples/page.html` ignores `index.html`);
* dot-paths such as `/.git/`, `projects/.jobs/` and `/server/` are served
  again.

So restore the backup only right after a failed `nginx -t` (nothing was
reloaded then; restoring keeps the broken file from being picked up by a later
reload), or together with a full revert of the migration.

### Reverting the folder migration

The migration only renamed files on the same filesystem and logged every
rename in `archive/migration-2026-10-07.tsv` (`source<TAB>destination`, one
`(symlink)` row for the compatibility link it created). Stop the service first,
then replay the log bottom-up as `sliadmin`: rename each destination back to its
source, and delete the link for the `(symlink)` row.

```bash
cd /mnt/Data2/potree
sudo systemctl stop potree-projects
revert() {  # "echo" = dry run that only prints the operations
	tac archive/migration-2026-10-07.tsv | while IFS=$'\t' read -r src dst; do
		if [ "$src" = "(symlink)" ]; then $1 rm -- "${dst%% -> *}"; else $1 mv -T -- "$dst" "$src"; fi || break
	done
}
revert echo     # check the list first
revert ""       # then run it (stops at the first error)
# the autoinspect page was edited in place for its new folder; restore its old paths
sed -i -e 's#"\./pointclouds/classes/#"../../examples/Potree_conv/#g' \
       -e 's#"\./\(images/\)\{0,1\}\(ParamCam\.xml\|camerat1z8\.txt\|icon/\|insit\.svg\)#"../../examples/autoinspect/\2#g' \
       examples/autoinspect/index.html
rmdir examples/autoinspect/images    # left empty by the revert
```

Then restore the old nginx config as above. Files generated after the
migration (`projects/<id>/project.json`, `index.html`, `preview.jpg`, the
portal) stay in place and do no harm.

## Running the service manually (without systemd)

Useful for development or before the unit is installed. Only one service may
use a `projects/` folder at a time: the service holds the lock file
`projects/.jobs/server.lock` and a second instance with the same projects
folder refuses to start (a stale lock left by a crashed process is detected
and replaced). Stop the systemd service first
(`sudo systemctl stop potree-projects`); a development instance that must run
next to it needs its own `PROJECTS_DIR` and `PORT`. `node server/cli.mjs create`
also refuses to run while the service is running.

```bash
cd /mnt/Data2/potree
umask 002     # group-writable output, like UMask=0002 in the unit
# reuse the service's token (or set any random value for a private test)
export API_TOKEN=$(sudo sed -n 's/^API_TOKEN=//p' /etc/potree-projects.env | tail -n 1)
HOST=127.0.0.1 PORT=8090 \
POTREE_ROOT=/mnt/Data2/potree \
POTREE_CONVERTER=/mnt/Data2/PotreeConverter/build/PotreeConverter \
ALLOWED_ROOTS=/mnt/Data2 \
nohup /usr/bin/node server/project-server.mjs >> ~/potree-projects.log 2>&1 &
echo $! > ~/potree-projects.pid

tail -f ~/potree-projects.log                       # log
kill "$(cat ~/potree-projects.pid)"                 # stop
```

Without `API_TOKEN` the service starts, but creating and editing projects is
disabled (`503`). Add `MOVE_ROOTS=…` the same way to test move imports.

## Testing an nginx change without root

The system `nginx -t` needs root, because it reads `/run/nginx.pid` and binds
:80. Before installing a change, you can run a private nginx instance on a test
port:

```bash
T=/tmp/potree-nginx-test; mkdir -p $T/{conf,logs,tmp}
sed -e 's/^\tlisten 8080;/\tlisten 127.0.0.1:18080;/' \
    -e 's/^\tlisten 8081;/\tlisten 127.0.0.1:18081;/' \
    -e 's/:8080\$request_uri/:18080$request_uri/' \
    -e "s#/var/log/nginx/#$T/logs/#" \
    deploy/nginx/potree.conf > $T/conf/potree.conf      # also change 8090 if needed
cat > $T/conf/nginx.conf <<EOF
pid $T/logs/nginx.pid;
error_log $T/logs/error.log;
events {}
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    client_body_temp_path $T/tmp/cb; proxy_temp_path $T/tmp/px;
    fastcgi_temp_path $T/tmp/fc; uwsgi_temp_path $T/tmp/uw; scgi_temp_path $T/tmp/sc;
    include $T/conf/potree.conf;
}
EOF
nginx -t -p $T -e $T/logs/error.log -c $T/conf/nginx.conf
nginx    -p $T -e $T/logs/error.log -c $T/conf/nginx.conf    # start
curl -sI http://127.0.0.1:18080/projects/vevey.html
nginx -s stop -p $T -e $T/logs/error.log -c $T/conf/nginx.conf
```
