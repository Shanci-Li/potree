# Batch Depth Rendering

This project provides batch equirectangular depth generation from Potree point clouds using `examples/depth_rendering.html` and the Node CLI coordinator in `tools/depth_batch_cli.mjs`.

The renderer outputs one single-band Float32 TIFF depth map per camera pose. Depth values are raw metric distances. Preview grayscale normalization is visual-only and does not change TIFF values.

## Inputs

- Point cloud asset: a Potree-compatible `metadata.json`, `ept.json`, `cloud.js`, COPC LAZ, or VPC URL/path.
- Camera poses: a Potree 360 `coordinates.txt` file.
- Output size: defaults to `8000 x 4000`.
- Classification filter: optional class indices such as `2` or `2,6,9-12`.

For Potree 360 coordinates, X/Y/Z are treated as point-cloud scene coordinates by default. Enable lon/lat transformation only when the file actually stores longitude/latitude and the point cloud has projection metadata.

## Browser Workflow

1. Start a local Potree server, for example:

   ```bash
   npx gulp webserver
   ```

2. Open:

   ```text
   http://127.0.0.1:1234/examples/depth_rendering.html
   ```

3. In the **Point Cloud** section, enter the point cloud asset URL or relative path and click **Load**.

4. In the **Coordinates** section, either:
   - enter a 360 image folder URL and click **Load 360 Coordinates**, or
   - select a local `coordinates.txt` file.

5. In **Classification Filter**, optionally enter class indices in **Class indices**:

   ```text
   2,6,9-12
   ```

   Leave it blank to render all visible classes.

6. Set output width, height, near/far, point budget, warmup frames, and point rendering settings.

7. In **Batch**, click **Select Save Folder**, then **Start Batch**.

The browser batch path renders sequentially in the current browser tab. Existing TIFFs are skipped unless **Overwrite existing TIFFs** is enabled.

## Browser Multi-GPU Coordinator Mode

Browser JavaScript cannot reliably pin WebGL contexts to specific GPUs. For multi-GPU rendering, start the local coordinator and use the browser page as a control panel.

Start the coordinator:

```bash
node tools/depth_batch_cli.mjs serve --out /data/depth --port 3100
```

In the browser **Batch** section:

1. Enable **Use local multi-GPU coordinator**.
2. Set **Coordinator URL** to:

   ```text
   http://127.0.0.1:3100
   ```

3. Set **Coordinator output directory** to the target directory on the coordinator machine.
4. Optionally set **GPU IDs**, for example:

   ```text
   0,1
   ```

5. Click **Start Batch**.

The coordinator launches Chromium workers and writes TIFFs directly on the coordinator machine.

## CLI Workflow

Run headless batch inference:

```bash
node tools/depth_batch_cli.mjs \
  --pointcloud /data/cloud/metadata.json \
  --coordinates /data/images/coordinates.txt \
  --out /data/depth \
  --gpus 0,1 \
  --classifications 2,6,9-12
```

Useful options:

```text
--width <n>              Default 8000
--height <n>             Default 4000
--near <n>               Default 0.1
--far <n>                Default 1000000
--point-budget <n>       Default 10000000
--warmup-frames <n>      Default 8
--point-size <n>         Default 1
--min-point-size <n>     Default 2
--max-point-size <n>     Default 50
--classifications <spec> Example: 2,6,9-12
--start-index <n>        First coordinate row
--end-index <n>          Last coordinate row
--gpus <ids>             Example: 0,1
--workers-per-gpu <n>    Default 1
--overwrite              Regenerate existing TIFFs
--headed                 Show Chromium windows for debugging
--browser-executable <p> Use a system Chrome/Chromium executable
--transform-lonlat       Transform coordinates through point-cloud projection
--legacy-potree-paths    Use legacy pano/coordinates.txt layout
```

If Playwright-managed Chromium is not installed, run:

```bash
npx playwright install chromium
```

Or use a system browser:

```bash
node tools/depth_batch_cli.mjs \
  --browser-executable /usr/bin/google-chrome \
  --pointcloud /data/cloud/metadata.json \
  --coordinates /data/images/coordinates.txt \
  --out /data/depth
```

## Output Naming

Output filenames are derived from the basename of the `File` column in `coordinates.txt`. Directory components in `File` are ignored, and only the filename suffix is replaced with `.tif`.

Examples:

```text
File column                 Output
image_001.jpg               image_001.tif
pano/cam_0001.png           cam_0001.tif
subdir/frame.jpeg           frame.tif
```

The output basename is sanitized before writing. Absolute paths, directory components, and `..` segments are not honored.

Existing TIFFs are skipped by default so interrupted batches can resume. Use `--overwrite` in CLI mode, or enable **Overwrite existing TIFFs** in the browser, to regenerate existing outputs.

Each CLI/coordinator run writes:

```text
batch_summary.json
```

The summary includes render settings, rendered/skipped/failed counts, and per-row status.

## Multi-GPU Notes

The first explicit multi-GPU target is NVIDIA Linux.

- If `--gpus` is omitted, the CLI tries to discover GPUs with `nvidia-smi`.
- The coordinator starts one Chromium worker per GPU by default.
- Increase parallelism with `--workers-per-gpu`, but monitor GPU memory usage.
- Each worker loads the point cloud independently, so high worker counts can increase VRAM and RAM usage significantly.

Example:

```bash
node tools/depth_batch_cli.mjs \
  --pointcloud /data/cloud/metadata.json \
  --coordinates /data/images/coordinates.txt \
  --out /data/depth \
  --gpus 0,1,2,3 \
  --workers-per-gpu 1
```

## Troubleshooting

- **S3 or remote point cloud does not load**: confirm CORS allows browser `GET` requests for `metadata.json` and all referenced point cloud files.
- **No GPU/WebGL in headless mode**: try `--headed`, `--browser-executable /path/to/chrome`, or verify NVIDIA drivers and container GPU access.
- **All rows fail immediately**: test a single row with `--start-index 0 --end-index 0 --headed`.
- **Wrong alignment with 360 images**: use Potree 360 coordinate rows and leave orientation convention as Potree 360; the depth renderer uses the same Potree 360 texture convention as the viewer.
- **Wrong coordinate position**: leave lon/lat transform disabled for scene-coordinate `coordinates.txt`; enable `--transform-lonlat` only for longitude/latitude files.
- **Classification selection produces empty output**: confirm the selected class indices exist in the point cloud classification attribute.
