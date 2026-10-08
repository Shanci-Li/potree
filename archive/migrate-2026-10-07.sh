#!/usr/bin/env bash
# One-off migration (2026-10-07): move private projects and their data out of
# examples/ and pointclouds/ into self-contained folders under projects/<id>/.
# Every move is a same-filesystem rename and is logged to migration-2026-10-07.tsv
# ("source<TAB>destination"), so the whole migration can be reversed by replaying
# the log bottom-up with `mv dst src`.
set -euo pipefail

ROOT=/mnt/Data2/potree
LOG="$ROOT/archive/migration-2026-10-07.tsv"
cd "$ROOT"

mvlog() {
	local src="$1" dst="$2"
	if [[ ! -e "$src" && ! -L "$src" ]]; then
		echo "missing source: $src" >&2; exit 1
	fi
	if [[ -e "$dst" || -L "$dst" ]]; then
		echo "refusing to overwrite: $dst" >&2; exit 1
	fi
	mkdir -p "$(dirname "$dst")"
	mv -T "$src" "$dst"
	printf '%s\t%s\n' "$src" "$dst" >> "$LOG"
	echo "moved $src -> $dst"
}

: > "$LOG"

# --- arolla (ground truth) ---------------------------------------------------
mvlog pointclouds/Arolla                               projects/arolla/pointcloud
mvlog projects/arolla/pointcloud/t1z4_gt.gpkg          projects/arolla/vectors/t1z4_gt.gpkg
# older 4-layer prediction file, not used by any page (the 6-layer one is in arolla-prediction)
mvlog projects/arolla/pointcloud/t1z4_predict.gpkg     projects/arolla/extras/t1z4_predict_4layers.gpkg

# --- arolla-prediction --------------------------------------------------------
mvlog pointclouds/Arolla_predictions                           projects/arolla-prediction/pointcloud
mvlog projects/arolla-prediction/pointcloud/t1z4_predict.gpkg  projects/arolla-prediction/vectors/t1z4_predict.gpkg
mvlog projects/arolla-prediction/pointcloud/t1z4_gt.gpkg       projects/arolla-prediction/vectors/t1z4_gt.gpkg

# --- grandson (ground truth + RANSAC ground truth) ----------------------------
mvlog pointclouds/Grandson                                  projects/grandson/pointcloud
mvlog projects/grandson/pointcloud/t3z1_gt.gpkg             projects/grandson/vectors/t3z1_gt.gpkg
mvlog projects/grandson/pointcloud/t3z1_gt_ransac.gpkg      projects/grandson/vectors/t3z1_gt_ransac.gpkg

# --- grandson-prediction ------------------------------------------------------
mvlog pointclouds/Grandson_prediction                            projects/grandson-prediction/pointcloud
mvlog projects/grandson-prediction/pointcloud/t3z1_pred.gpkg     projects/grandson-prediction/vectors/t3z1_pred.gpkg

# --- neuchatel ----------------------------------------------------------------
mvlog pointclouds/neuchatel                    projects/neuchatel/pointcloud
mvlog projects/neuchatel/pointcloud/pano       projects/neuchatel/images360
mvlog projects/neuchatel/pointcloud/label      projects/neuchatel/labels/cityscape

# --- ollon-idw ----------------------------------------------------------------
mvlog pointclouds/ollon_idw                                    projects/ollon-idw/pointcloud
mvlog projects/ollon-idw/pointcloud/JPG                        projects/ollon-idw/images360
mvlog projects/ollon-idw/pointcloud/label_cityscape            projects/ollon-idw/labels/cityscape
mvlog projects/ollon-idw/pointcloud/label_sam                  projects/ollon-idw/labels/sam
mvlog projects/ollon-idw/pointcloud/wall_polygons.gpkg         projects/ollon-idw/vectors/wall_polygons.gpkg
mvlog projects/ollon-idw/pointcloud/M251106_POS_ORI_AXE5161_MN95_NF02.csv \
      projects/ollon-idw/extras/M251106_POS_ORI_AXE5161_MN95_NF02.csv

# --- streetview-ne ------------------------------------------------------------
mvlog pointclouds/streetview_ne                       projects/streetview-ne/pointcloud
mvlog projects/streetview-ne/pointcloud/pano          projects/streetview-ne/images360
mvlog projects/streetview-ne/pointcloud/NE_GT_3D.gpkg projects/streetview-ne/vectors/NE_GT_3D.gpkg

# --- valais -------------------------------------------------------------------
mvlog pointclouds/valais                          projects/valais/pointcloud
mvlog projects/valais/pointcloud/demo_vector.gpkg projects/valais/vectors/demo_vector.gpkg

# --- vevey --------------------------------------------------------------------
mvlog pointclouds/vevey                 projects/vevey/pointcloud
mvlog pointclouds/vevey_pano            projects/vevey/images360
mvlog projects/vevey/images360/label    projects/vevey/labels/cityscape
mvlog pointclouds/vevey_detections      projects/vevey/vectors/detections
# nearai-seg/pipeline_vevey/{deploy.sh,publish_to_potree.py} still publish to the old path
ln -s ../projects/vevey/vectors/detections pointclouds/vevey_detections
printf '%s\t%s\n' "(symlink)" "pointclouds/vevey_detections -> ../projects/vevey/vectors/detections" >> "$LOG"

# --- neocapture-voiteur -------------------------------------------------------
mvlog pointclouds/voiteur                              projects/neocapture-voiteur/pointcloud
mvlog projects/neocapture-voiteur/pointcloud/01_images projects/neocapture-voiteur/images360

# --- autoinspect (custom page, keeps its own libs/ and layout) ----------------
mvlog examples/autoinspect   projects/autoinspect
mvlog examples/Potree_conv   projects/autoinspect/pointclouds/classes
mkdir -p projects/autoinspect/images
for f in projects/autoinspect/DJI_*.JPG projects/autoinspect/camerat1z8.txt \
         projects/autoinspect/ParamCam.xml projects/autoinspect/cam_t1z8_xml.xml; do
	mvlog "$f" "projects/autoinspect/images/$(basename "$f")"
done

# --- superseded hand-written pages -------------------------------------------
for f in projects/*.html; do
	mvlog "$f" "archive/legacy-pages/projects/$(basename "$f")"
done
for f in Arolla Arolla_prediction Grandsons Grandsons_prediction Grandsons_ransac vevey; do
	mvlog "examples/$f.html" "archive/legacy-pages/examples/$f.html"
done

echo "done: $(wc -l < "$LOG") log lines in $LOG"
