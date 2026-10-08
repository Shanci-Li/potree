#!/usr/bin/env bash
# One-off merge (2026-10-07): arolla-prediction -> arolla, grandson-prediction -> grandson.
# The prediction point cloud of each pair becomes a second, initially hidden point cloud
# (pointcloud-prediction/) of the merged project; prediction vectors join vectors/.
# Every move is a same-filesystem rename logged to merge-2026-10-07.tsv ("source<TAB>destination");
# replay the log bottom-up with `mv dst src` to undo. Nothing is deleted.
set -euo pipefail

ROOT=/mnt/Data2/potree
LOG="$ROOT/archive/merge-2026-10-07.tsv"
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

# --- arolla ------------------------------------------------------------------
mvlog projects/arolla-prediction/pointcloud                 projects/arolla/pointcloud-prediction
mvlog projects/arolla-prediction/vectors/t1z4_predict.gpkg  projects/arolla/vectors/t1z4_predict.gpkg
# byte-identical to projects/arolla/vectors/t1z4_gt.gpkg (md5 0abe5780...)
mvlog projects/arolla-prediction/vectors/t1z4_gt.gpkg       archive/merged-projects/arolla-prediction/vectors/t1z4_gt.gpkg
for f in project.json index.html preview.jpg; do
	mvlog "projects/arolla-prediction/$f" "archive/merged-projects/arolla-prediction/$f"
done
rmdir projects/arolla-prediction/vectors projects/arolla-prediction

# --- grandson ----------------------------------------------------------------
mvlog projects/grandson-prediction/pointcloud               projects/grandson/pointcloud-prediction
mvlog projects/grandson-prediction/vectors/t3z1_pred.gpkg   projects/grandson/vectors/t3z1_pred.gpkg
for f in project.json index.html preview.jpg; do
	mvlog "projects/grandson-prediction/$f" "archive/merged-projects/grandson-prediction/$f"
done
rmdir projects/grandson-prediction/vectors projects/grandson-prediction

echo "done: $(wc -l < "$LOG") moves logged in $LOG"
