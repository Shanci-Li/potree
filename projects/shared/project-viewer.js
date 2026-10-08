/**
 * Shared runtime for generated project pages (projects/<id>/index.html).
 *
 * A page creates `window.viewer = new Potree.Viewer(...)` and calls
 * `await loadProject(window.viewer, "./project.json")`; everything else —
 * viewer settings, sidebar, point clouds, material, view, vector layers,
 * meshes and 360° images — is driven by the project's manifest
 * (schema: projects/README.md).
 *
 * Robustness rules:
 * - the point cloud is the only required layer. If project.json or every
 *   point cloud fails, a visible error panel replaces the page content;
 * - every optional layer loads independently and never blocks the point
 *   cloud. A failure or a remote host that does not answer within
 *   LAYER_TIMEOUT_MS only produces a console warning and a small
 *   dismissible notice.
 *
 * Preview mode (`?preview=1`, used by the headless preview renderer): no
 * sidebar or page chrome, 360° spheres hidden, a budget of at least
 * 3,000,000 points and an opaque background. Once the scene has settled,
 * `window.__projectReady = true`. A fatal error — including a scene that has
 * drawn no point at all by the hard timeout — also sets
 * `window.__projectError`, so the renderer never saves a blank preview.
 *
 * `loadProject` never rejects. It resolves with the context object (also
 * exposed as `window.projectContext`), whose `error` is set on fatal failure.
 */

import {getProj4, normalizeCrsName, registerCrs} from "./crs.js";

const LAYER_TIMEOUT_MS = 30_000;
const POINTCLOUD_TIMEOUT_MS = 60_000;
const PREVIEW_MIN_POINT_BUDGET = 3_000_000;
const OPAQUE_BACKGROUNDS = ["gradient", "black", "white", "skybox"];
/** Viewports up to this width (px) start with the sidebar closed. */
const NARROW_SCREEN_MAX_WIDTH = 700;

/** Settle detection for the preview renderer (see waitForSettled). */
const SETTLE = {
	quietFrames: 30,      // consecutive frames with nothing loading and an unchanged visible set
	quietMs: 1500,        // ... lasting at least this long
	minMs: 2000,          // never ready earlier than this after the view is applied
	hardTimeoutMs: 90_000 // ready no matter what, counted from the start of loadProject
};

const VIEWER_DEFAULTS = {
	pointBudget: 2_000_000,
	fov: 60,
	edl: true,
	controls: "earth",
	classificationScheme: null,
	background: null,
	language: "en",
	openMenus: ["tools", "scene", "filters"],
	sidebar: true,
	description: "",
};

const IDENTITY = {forward: a => a, inverse: a => a};

class TimeoutError extends Error {
	constructor(message){
		super(message);
		this.name = "TimeoutError";
	}
}

/** True when the page URL asks for the headless preview (`?preview` or `?preview=1`). */
export function isPreviewMode(){
	const value = new URLSearchParams(window.location.search).get("preview");
	return value !== null && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * Loads `projectUrl` (relative to the page) and builds the scene it describes.
 *
 * hooks.onPointCloudLoaded(pointcloud, config, ctx) — after each point cloud
 *   is configured and added to the scene;
 * hooks.onLoaded(ctx) — once the point clouds are in and every optional layer
 *   has loaded, failed or timed out.
 *
 * @returns {Promise<object>} ctx = { project, viewer, pointclouds, images360,
 *   geopackages, meshes, preview, warnings, timings (ms since start per phase),
 *   settle (preview: {timedOut, ms}), loaded, error }
 */
export async function loadProject(viewer, projectUrl = "./project.json", hooks = {}){
	const startedAt = performance.now();
	const preview = isPreviewMode();
	const deadline = startedAt + SETTLE.hardTimeoutMs;

	const ctx = {
		project: null,
		viewer,
		pointclouds: [],
		images360: null,
		geopackages: [],
		meshes: [],
		preview,
		warnings: [],
		timings: {},
		settle: null,
		loaded: false,
		error: null,
	};
	window.projectContext = ctx;
	const mark = key => { ctx.timings[key] = Math.round(performance.now() - startedAt); };

	injectStyles();
	if(preview){
		document.documentElement.classList.add("project-preview");
	}

	try{
		const projectHref = new URL(projectUrl, document.baseURI).href;
		let project;
		try{
			project = await fetchWithTimeout(projectHref, {as: "json", cache: "no-cache"});
		}catch(err){
			throw new Error(`Could not read ${projectUrl}: ${describeError(err)}`);
		}
		if(!project || typeof project !== "object" || Array.isArray(project)){
			throw new Error(`${projectUrl} is not a project manifest (expected a JSON object).`);
		}
		ctx.project = project;
		mark("projectJson");
		checkPageProjectId(project);

		const resolveUrl = url => new URL(url, projectHref).href;
		// Only the definitions proj4 accepted are used from here on; a rejected
		// one makes its layers fall back to identity (with a warning) later.
		const {crsDefs, rejected} = registerCrs(proj4, project);
		for(const {name, error} of rejected){
			warn(ctx, name === null ? `${error}; ignored`
				: `crsDefs["${name}"] is not a usable proj4 definition (${error}); ignored`);
		}

		const settings = {...VIEWER_DEFAULTS, ...(project.viewer || {})};
		applyViewerSettings(viewer, settings, preview);
		if(!preview){
			loadGui(viewer, settings);
			keepBackLinkClear(viewer);
		}

		await loadPointClouds(viewer, project, resolveUrl, ctx, hooks);
		mark("pointclouds");
		if(!preview){
			watchPointCloudData(ctx);
		}

		// The preview may frame a close-up (`previewView`) when the opening view
		// of a long survey would show it as a thin line in a 1280×720 card.
		applyView(viewer, (preview && project.previewView) || project.view);
		const viewAppliedAt = performance.now();

		const transformFor = createTransformFactory(project, crsDefs, viewer, ctx);
		const env = {viewer, project, resolveUrl, transformFor, ctx, preview, vectorOrder: new Map()};
		const tasks = [];

		const vectors = Array.isArray(project.vectors) ? project.vectors : [];
		vectors.forEach((entry, index) => {
			const label = vectorLabel(entry, index);
			tasks.push(trackLayer(ctx, label, loadVectorEntry(env, entry, index, label, vectors.length > 1)));
		});
		if(vectors.length > 0){
			syncLineResolution(viewer);
		}

		const meshes = Array.isArray(project.meshes) ? project.meshes : [];
		meshes.forEach((entry, index) => {
			const label = `Mesh "${(entry && (entry.name || basename(entry.url))) || index + 1}"`;
			tasks.push(trackLayer(ctx, label, loadMesh(env, entry, index)));
		});

		if(project.images360 && project.images360.url !== null){
			tasks.push(trackLayer(ctx, "360° images", loadImages360(env, project.images360)));
		}

		// Every task settles within LAYER_TIMEOUT_MS; the race only guards the
		// preview's hard deadline.
		await raceDeadline(Promise.allSettled(tasks), preview ? deadline : Infinity);
		mark("layers");

		// Layers were added as they arrived; list them in manifest order.
		ctx.geopackages.sort((a, b) => env.vectorOrder.get(a) - env.vectorOrder.get(b));
		if(!preview && vectors.length > 1){
			viewer.onGUILoaded(() => orderVectorTree(ctx.geopackages));
		}

		ctx.loaded = true;
		if(hooks.onLoaded){
			try{
				await hooks.onLoaded(ctx);
			}catch(err){
				console.error("[project] onLoaded hook failed", err);
				notify(ctx, `Page script error: ${describeError(err)}`);
			}
		}

		if(preview){
			const result = await waitForSettled(viewer, viewAppliedAt, deadline);
			ctx.settle = result;
			mark("ready");
			if(result.timedOut){
				// Never hand the renderer a blank or frozen frame: it would replace
				// the project's last good preview.
				if(result.stalled){
					throw new Error("the 3D view stopped rendering (an error in Potree's render loop; see the browser console)");
				}
				// Potree retries unreadable octree nodes forever, so damaged data
				// ends here. (numVisiblePoints also counts nodes still waiting for
				// their data; visibleNodes holds only nodes that are drawn.)
				if(ctx.pointclouds.every(pc => pc.visibleNodes.length === 0)){
					throw new Error(ctx.pointclouds.some(hasPointCloudData)
						? `no points were drawn within ${SETTLE.hardTimeoutMs / 1000} s (point cloud data incomplete or damaged?)`
						: `point cloud data could not be loaded (no octree node within ${SETTLE.hardTimeoutMs / 1000} s)`);
				}
				console.warn(`[project] scene did not settle within ${SETTLE.hardTimeoutMs / 1000} s; using the current frame`);
			}
			window.__projectReady = true;
		}
	}catch(err){
		ctx.error = describeError(err);
		console.error("[project] fatal:", err);
		showFatalError(ctx.error);
		mark("failed");
		if(preview){
			window.__projectError = ctx.error;
			window.__projectReady = true;
		}
	}

	return ctx;
}

// ---------------------------------------------------------------------------
// Viewer and GUI
// ---------------------------------------------------------------------------

function applyViewerSettings(viewer, settings, preview){
	viewer.setPointBudget(positiveNumber(settings.pointBudget, VIEWER_DEFAULTS.pointBudget));
	viewer.setFOV(positiveNumber(settings.fov, VIEWER_DEFAULTS.fov));
	viewer.setEDLEnabled(settings.edl !== false);

	const controls = {
		earth: viewer.earthControls,
		orbit: viewer.orbitControls,
		fly: viewer.fpControls,
	}[String(settings.controls || "").toLowerCase()];
	if(controls){
		viewer.setControls(controls);
	}else if(settings.controls){
		console.warn(`[project] unknown viewer.controls "${settings.controls}" (earth | orbit | fly)`);
	}

	if(settings.classificationScheme){
		const scheme = Potree.ClassificationScheme[settings.classificationScheme];
		if(scheme){
			viewer.setClassifications(scheme);
		}else{
			console.warn(`[project] unknown classificationScheme "${settings.classificationScheme}"`);
		}
	}

	if(settings.background){
		viewer.setBackground(settings.background);
	}

	viewer.setDescription(preview ? "" : (settings.description || ""));

	// URL parameters (pointBudget, position, background, ...) override the project.
	viewer.loadSettingsFromURL();

	if(preview){
		viewer.setPointBudget(Math.max(Potree.pointBudget, PREVIEW_MIN_POINT_BUDGET));
		if(!OPAQUE_BACKGROUNDS.includes(viewer.getBackground())){
			viewer.setBackground("gradient");
		}
	}
}

function loadGui(viewer, settings){
	viewer.loadGUI(() => {
		viewer.setLanguage(settings.language || VIEWER_DEFAULTS.language);

		const menus = Array.isArray(settings.openMenus) ? settings.openMenus : [];
		for(const menu of menus){
			if(/^[a-z0-9_-]+$/i.test(menu)){
				$(`#menu_${menu}`).next().show();
			}
		}

		// The sidebar is 300 px wide: on a phone it would leave only a sliver
		// of the 3D view, so there it starts closed (the menu button opens it).
		if(settings.sidebar !== false && window.innerWidth > NARROW_SCREEN_MAX_WIDTH){
			viewer.toggleSidebar();
		}

		try{
			viewer.mapView.showSources(true);
		}catch(err){
			// The map is only initialised when OpenLayers is present and the
			// point cloud has a projection.
			console.info("[project] map sources not shown:", describeError(err));
		}
	});
}

/**
 * The page's "← Projects" link (server/templates/project.html) sits at the top
 * right of the page; Potree's quick buttons (menu, map) form a column at the
 * top left of the render area, which moves 300 px to the right while the
 * sidebar is open. On a narrow screen with the sidebar open the two meet, and
 * the link would cover the menu button — the only way to close the sidebar.
 * Hide the link for as long as it would touch that column; it comes back when
 * there is room again (sidebar closed or a wider window).
 */
function keepBackLinkClear(viewer){
	const link = document.querySelector(".project-backlink");
	const renderArea = viewer.renderArea;
	if(!link || !renderArea || typeof ResizeObserver !== "function"){
		return;
	}
	const gap = 8;
	const update = () => {
		const linkBox = link.getBoundingClientRect();
		const blocked = [...renderArea.querySelectorAll("#potree_quick_buttons > *")].some(button => {
			const box = button.getBoundingClientRect();
			return box.width > 0 && box.height > 0
				&& box.left < linkBox.right + gap && linkBox.left < box.right + gap
				&& box.top < linkBox.bottom + gap && linkBox.top < box.bottom + gap;
		});
		link.style.visibility = blocked ? "hidden" : "";
	};
	// The render area changes size with the window and, frame by frame, while
	// the sidebar slides in or out (Potree animates its `left`).
	new ResizeObserver(update).observe(renderArea);
}

function checkPageProjectId(project){
	const pageId = document.body && document.body.dataset.projectId;
	if(pageId && project.id && pageId !== project.id){
		console.warn(`[project] page was generated for "${pageId}" but project.json has id "${project.id}"`);
	}
}

function applyView(viewer, view){
	// A camera given in the page URL (?position=...&target=...) was applied by
	// loadSettingsFromURL and wins over the project's view.
	if(new URLSearchParams(window.location.search).has("position")){
		return;
	}
	if(view && isVector3(view.position) && isVector3(view.target)){
		viewer.scene.view.setView(view.position, view.target);
	}else{
		viewer.fitToScreen();
	}
}

// ---------------------------------------------------------------------------
// Point clouds
// ---------------------------------------------------------------------------

async function loadPointClouds(viewer, project, resolveUrl, ctx, hooks){
	const configs = Array.isArray(project.pointclouds) ? project.pointclouds : [];
	if(configs.length === 0){
		throw new Error("project.json lists no point clouds.");
	}

	// Load in parallel, add in manifest order: the first cloud defines the
	// scene projection (viewer.getProjection()).
	const results = await Promise.allSettled(configs.map((cfg, i) => loadPointCloud(cfg, i, resolveUrl)));

	const failures = [];
	results.forEach((result, i) => {
		const cfg = configs[i];
		if(result.status === "rejected"){
			const name = (cfg && (cfg.name || cfg.url)) || `#${i + 1}`;
			failures.push(`${name}: ${describeError(result.reason)}`);
			return;
		}
		const pointcloud = result.value;
		useTightBoundingBox(pointcloud);
		applyMaterial(pointcloud.material, cfg.material || {});
		// `visible: false` lists the cloud unticked in the scene tree (e.g. a
		// prediction next to the ground truth); Potree loads no data for it until ticked.
		pointcloud.visible = cfg.visible !== false;
		viewer.scene.addPointCloud(pointcloud);
		ctx.pointclouds.push(pointcloud);
		if(hooks.onPointCloudLoaded){
			try{
				hooks.onPointCloudLoaded(pointcloud, cfg, ctx);
			}catch(err){
				console.error("[project] onPointCloudLoaded hook failed", err);
			}
		}
	});

	if(ctx.pointclouds.length === 0){
		throw new Error(`The point cloud could not be loaded. ${failures.join("; ")}`);
	}
	for(const failure of failures){
		notify(ctx, `Point cloud ${failure}`);
	}
}

async function loadPointCloud(cfg, index, resolveUrl){
	if(!cfg || !cfg.url){
		throw new Error(`pointclouds[${index}] has no url`);
	}
	const url = resolveUrl(cfg.url);
	const name = cfg.name || `pointcloud ${index + 1}`;

	// Potree.loadPointCloud never settles when the metadata is missing or
	// unreachable, so check it first: small JSON descriptors are fetched and
	// parsed, anything else (e.g. a COPC file) is only probed.
	const path = new URL(url).pathname;
	if(/\.json$|cloud\.js$/i.test(path)){
		const metadata = await fetchWithTimeout(url, {as: "json"});
		if(/(^|\/)metadata\.json$/i.test(path)){
			await checkOctreeFiles(url, metadata);
		}
	}else{
		await probeUrl(url);
	}

	// The callback form is the one that sets pointcloud.name.
	const loaded = new Promise(resolve => Potree.loadPointCloud(url, name, resolve));
	const e = await withTimeout(loaded, POINTCLOUD_TIMEOUT_MS,
		`not ready after ${POINTCLOUD_TIMEOUT_MS / 1000} s (unsupported format?)`);
	return e.pointcloud;
}

/**
 * A PotreeConverter 2.x cloud is metadata.json plus hierarchy.bin and
 * octree.bin next to it. Potree reads only the metadata up front and then
 * retries every node it cannot read, silently and forever, so missing or
 * cut-off data files would leave an empty scene without a word (and a blank
 * preview). Check that both exist and are not obviously truncated: hierarchy.bin
 * must hold at least the first chunk the metadata announces.
 */
async function checkOctreeFiles(metadataUrl, metadata){
	const firstChunkSize = Number(metadata && metadata.hierarchy && metadata.hierarchy.firstChunkSize);
	const points = Number(metadata && metadata.points);
	const minimumBytes = {
		"hierarchy.bin": firstChunkSize > 0 ? firstChunkSize : 1,
		"octree.bin": points > 0 ? 1 : 0,
	};

	await Promise.all(Object.entries(minimumBytes).map(async ([file, minimum]) => {
		let size;
		try{
			size = await probeUrl(new URL(file, metadataUrl).href);
		}catch(err){
			throw new Error(`${file}: ${describeError(err)}`);
		}
		if(size !== null && size < minimum){
			throw new Error(`${file} is truncated (${size} bytes, expected at least ${minimum})`);
		}
	}));
}

/** True once Potree holds the root node of `pointcloud` (or draws any of it). */
function hasPointCloudData(pointcloud){
	const root = pointcloud.pcoGeometry && pointcloud.pcoGeometry.root;
	return Boolean(root && root.loaded) || pointcloud.visibleNodes.length > 0;
}

/**
 * Damage the up-front checks cannot see (e.g. an octree.bin cut short or
 * overwritten) still ends in Potree's silent retry loop: tell the visitor when
 * no point cloud has any data after LAYER_TIMEOUT_MS, and withdraw the
 * notice if the data turns out to be merely slow.
 */
function watchPointCloudData(ctx){
	const startedAt = performance.now();
	let dismiss = null;
	const timer = setInterval(() => {
		if(ctx.pointclouds.some(hasPointCloudData)){
			clearInterval(timer);
			if(dismiss){
				dismiss();
				console.info("[project] point cloud data arrived after all");
			}
		}else if(!dismiss && performance.now() - startedAt >= LAYER_TIMEOUT_MS){
			dismiss = notify(ctx, `No point cloud data has arrived after ${LAYER_TIMEOUT_MS / 1000} s: `
				+ "its octree files may be damaged, or the server is very slow (see the browser console).");
		}
	}, 1000);
}

/**
 * Potree 2.0 octrees report their cubic octree box as the "tight" box, so
 * fitToScreen, the sidebar's zoom and the map frame a cube that is often far
 * taller than the data (Ollon: 7.2 km cube for 0.9 km of relief), leaving the
 * cloud small and low in the frame. The metadata's position range is the real
 * extent; use it.
 */
function useTightBoundingBox(pointcloud){
	const geometry = pointcloud.pcoGeometry;
	if(!geometry || !geometry.offset || !geometry.tightBoundingBox || !geometry.boundingBox
		|| !geometry.tightBoundingBox.equals(geometry.boundingBox)){
		return;
	}
	const attributes = geometry.pointAttributes && geometry.pointAttributes.attributes;
	const position = Array.isArray(attributes) ? attributes.find(a => a.name === "position") : null;
	const [min, max] = position && Array.isArray(position.range) ? position.range : [];
	if(!Array.isArray(min) || !Array.isArray(max) || ![...min, ...max].every(Number.isFinite)){
		return;
	}

	const box = geometry.boundingBox.clone();
	box.min.fromArray(min).sub(geometry.offset);
	box.max.fromArray(max).sub(geometry.offset);
	geometry.tightBoundingBox = box;
	if(geometry.tightBoundingSphere){
		box.getBoundingSphere(geometry.tightBoundingSphere);
	}
}

function applyMaterial(material, cfg){
	if(cfg.ranges && typeof cfg.ranges === "object"){
		for(const [attribute, range] of Object.entries(cfg.ranges)){
			if(Array.isArray(range) && range.length === 2 && range.every(Number.isFinite)){
				material.setRange(attribute, [range[0], range[1]]);
			}else{
				console.warn(`[project] ignoring material.ranges.${attribute}: expected [min, max]`);
			}
		}
	}

	if(Number.isFinite(cfg.size)){
		material.size = cfg.size;
	}
	if(Number.isFinite(cfg.minSize)){
		material.minSize = cfg.minSize;
	}
	const sizeType = enumValue(Potree.PointSizeType, cfg.pointSizeType, "pointSizeType");
	if(sizeType !== undefined){
		material.pointSizeType = sizeType;
	}
	const shape = enumValue(Potree.PointShape, cfg.shape, "shape");
	if(shape !== undefined){
		material.shape = shape;
	}

	const baseGradient = gradientByKey(cfg.gradient, "material.gradient");
	if(baseGradient){
		material.gradient = baseGradient;
	}

	const perAttribute = {};
	for(const [attribute, key] of Object.entries(cfg.gradients || {})){
		const gradient = gradientByKey(key, `material.gradients.${attribute}`);
		if(gradient){
			perAttribute[attribute] = gradient;
		}
	}
	if(Object.keys(perAttribute).length > 0){
		bindAttributeGradients(material, perAttribute);
	}

	if(cfg.activeAttribute){
		material.activeAttributeName = cfg.activeAttribute;
	}
}

/**
 * Gives some attributes their own gradient (e.g. img_label -> CITYSCAPE).
 * Switching to an attribute without an entry restores the gradient that was
 * in use before — the configured one, or whatever the user picked meanwhile.
 */
function bindAttributeGradients(material, gradients){
	let fallback = material.gradient;
	let mapped = false;

	const apply = () => {
		const gradient = gradients[material.activeAttributeName];
		if(gradient){
			if(!mapped){
				fallback = material.gradient;
			}
			material.gradient = gradient;
			mapped = true;
		}else if(mapped){
			material.gradient = fallback;
			mapped = false;
		}
	};

	material.addEventListener("active_attribute_changed", apply);
	apply();
}

function gradientByKey(key, field){
	if(!key){
		return null;
	}
	const gradient = Potree.Gradients[String(key).toUpperCase()];
	if(!gradient){
		console.warn(`[project] unknown gradient "${key}" in ${field} (known: ${Object.keys(Potree.Gradients).join(", ")})`);
	}
	return gradient || null;
}

function enumValue(enumeration, key, field){
	if(key === undefined || key === null || key === ""){
		return undefined;
	}
	const value = enumeration[String(key).toUpperCase()];
	if(value === undefined){
		console.warn(`[project] unknown material.${field} "${key}" (known: ${Object.keys(enumeration).join(", ")})`);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Coordinate transforms
// ---------------------------------------------------------------------------

/**
 * Returns `transformFor(layerCrs, label)`: null when the layer is in the
 * point cloud's CRS (identity), else a proj4 converter from the layer CRS to
 * the point cloud's projection (or the project CRS when the cloud has none).
 * Falls back to null with a warning when either side has no definition.
 * `crsDefs` are the project's extra definitions that proj4 accepted
 * (see registerCrs).
 */
function createTransformFactory(project, crsDefs, viewer, ctx){
	const projectCrs = normalizeCrsName(project.crs);

	return (layerCrs, label) => {
		const crs = normalizeCrsName(layerCrs);
		if(crs === null || crs === projectCrs){
			return null;
		}

		const sourceDef = getProj4(layerCrs, crsDefs);
		const projectDef = getProj4(project.crs, crsDefs);
		if(!sourceDef || !projectDef){
			const missing = !sourceDef ? layerCrs : (project.crs || "(none)");
			warn(ctx, `${label}: no proj4 definition for ${missing}; drawing it untransformed`);
			return null;
		}

		try{
			const projection = viewer.getProjection();
			if(projection){
				proj4.defs("pointcloud", projection);
				return proj4(sourceDef, "pointcloud");
			}
			return proj4(sourceDef, projectDef);
		}catch(err){
			warn(ctx, `${label}: cannot transform ${layerCrs} to the point cloud CRS (${describeError(err)}); drawing it untransformed`);
			return null;
		}
	};
}

// ---------------------------------------------------------------------------
// Vector layers (GeoPackage)
// ---------------------------------------------------------------------------

function vectorLabel(entry, index){
	const name = entry && (entry.name || basename(entry.url || entry.manifest));
	return `Vector layer "${name || index + 1}"`;
}

async function loadVectorEntry(env, entry, index, label, qualifyNames){
	if(!entry || (!entry.url && !entry.manifest)){
		throw new Error("needs a url or a manifest");
	}
	const transform = env.transformFor(entry.crs, label) || IDENTITY;

	if(entry.manifest){
		await loadVectorManifest(env, entry, index, transform, qualifyNames);
	}else if(entry.lazy){
		const tables = Array.isArray(entry.tables) && entry.tables.length > 0 ? entry.tables : undefined;
		const geopackage = await Potree.GeoPackageLoader.loadUrlLazy(env.resolveUrl(entry.url), {tables, transform});
		addGeopackage(env, entry, index, geopackage, qualifyNames);
	}else{
		const url = env.resolveUrl(entry.url);
		// Download with our own timeout (GeoPackageLoader.loadUrl has none),
		// then parse; trackLayer bounds the wait for the parse.
		const buffer = await fetchWithTimeout(url, {as: "arrayBuffer"});
		const geopackage = await Potree.GeoPackageLoader.loadBuffer(buffer, {transform, source: url});
		addGeopackage(env, entry, index, geopackage, qualifyNames);
	}
}

/**
 * Lazy layers listed by a manifest (`{"files":[{"file","layers":[{"name"}]}]}`,
 * files relative to the manifest): nothing is downloaded until a layer is
 * ticked in the scene tree.
 */
async function loadVectorManifest(env, entry, index, transform, qualifyNames){
	const manifestUrl = env.resolveUrl(entry.manifest);
	const manifest = await fetchWithTimeout(manifestUrl, {as: "json"});
	const files = manifest && Array.isArray(manifest.files) ? manifest.files : [];
	if(files.length === 0){
		throw new Error(`${entry.manifest} lists no files`);
	}

	for(const file of files){
		if(!file || !file.file){
			continue;
		}
		const url = new URL(file.file, manifestUrl).href;
		const tables = (Array.isArray(file.layers) ? file.layers : []).map(layer => layer && layer.name).filter(Boolean);
		const geopackage = await Potree.GeoPackageLoader.loadUrlLazy(url,
			{tables: tables.length > 0 ? tables : undefined, transform});
		addGeopackage(env, entry, index, geopackage, qualifyNames);
	}
}

function addGeopackage(env, entry, index, geopackage, qualifyNames){
	const layers = geopackage.node.children;

	// Several sources often share table names (prediction vs ground truth):
	// tell them apart in the scene tree. Colours were chosen from the table
	// name already, or are captured by the lazy builder, so renaming is safe.
	if(qualifyNames && entry.name){
		for(const layer of layers){
			layer.name = `${layer.name} — ${entry.name}`;
		}
	}

	// The scene tree reads `visible` once, when the layer is added. Lazy layers
	// start hidden (showing one builds it), eager layers start visible.
	const lazy = Boolean(entry.manifest || entry.lazy);
	if(lazy ? entry.visible === true : entry.visible === false){
		for(const layer of layers){
			layer.visible = lazy;
		}
	}

	env.viewer.scene.addGeopackage(geopackage);
	env.ctx.geopackages.push(geopackage);
	env.vectorOrder.set(geopackage, index);
}

/** Moves the scene tree's vector nodes into the order of `geopackages`. */
function orderVectorTree(geopackages){
	const tree = $("#jstree_scene");
	const root = tree.jstree("get_node", "vectors");
	if(!root){
		return;
	}
	const nodeByLayer = new Map(root.children.map(id => [tree.jstree("get_node", id).data, id]));
	for(const geopackage of geopackages){
		for(const layer of geopackage.node.children){
			const id = nodeByLayer.get(layer);
			if(id){
				tree.jstree("move_node", id, "vectors", "last");
			}
		}
	}
}

/** LineMaterial sizes `linewidth` against the canvas size it is told; keep it current. */
function syncLineResolution(viewer){
	viewer.addEventListener("update", () => {
		const materials = Potree.GeoPackageLoader._materials;
		if(!materials){
			return;
		}
		for(const material of materials){
			viewer.renderer.getSize(material.resolution);
		}
	});
}

// ---------------------------------------------------------------------------
// Meshes (PLY)
// ---------------------------------------------------------------------------

let threeModules = null;

/** The repo's three.js module build and its PLYLoader, loaded on first use. */
function loadThreeModules(){
	if(!threeModules){
		const three = new URL("../../libs/three.js/build/three.module.js", import.meta.url).href;
		const ply = new URL("../../libs/three.js/loaders/PLYLoader.js", import.meta.url).href;
		threeModules = Promise.all([import(three), import(ply)])
			.then(([THREE, {PLYLoader}]) => ({THREE, PLYLoader}));
		threeModules.catch(() => { threeModules = null; });
	}
	return threeModules;
}

async function loadMesh(env, entry, index){
	if(!entry || !entry.url){
		throw new Error("needs a url");
	}
	const format = String(entry.format || entry.url.split(/[?#]/)[0].split(".").pop()).toLowerCase();
	if(format !== "ply"){
		throw new Error(`unsupported format "${format}" (only ply)`);
	}

	const name = entry.name || basename(entry.url) || `mesh ${index + 1}`;
	const transform = env.transformFor(entry.crs, `Mesh "${name}"`);
	const [{THREE, PLYLoader}, buffer] = await Promise.all([
		loadThreeModules(),
		fetchWithTimeout(env.resolveUrl(entry.url), {as: "arrayBuffer"}),
	]);

	const geometry = new PLYLoader().parse(buffer);
	const position = geometry.attributes.position;
	if(!position || position.count === 0){
		throw new Error("the file contains no vertices");
	}

	if(transform){
		for(let i = 0; i < position.count; i++){
			const [x, y] = transform.forward([position.getX(i), position.getY(i)]);
			position.setXY(i, x, y);
		}
	}

	// Keep vertex coordinates small and carry the offset on the object, so
	// the GPU does not lose precision on projected coordinates (the PLY
	// itself is Float32 already).
	geometry.computeBoundingBox();
	const center = geometry.boundingBox.getCenter(new THREE.Vector3()).round();
	geometry.translate(-center.x, -center.y, -center.z);
	position.needsUpdate = true;

	const opacity = Number.isFinite(entry.opacity) ? Math.min(Math.max(entry.opacity, 0), 1) : 1;
	const useVertexColors = !entry.color && Boolean(geometry.attributes.color);
	const common = {
		color: new THREE.Color(useVertexColors ? "#ffffff" : (entry.color || "#4488cc")),
		vertexColors: useVertexColors,
		transparent: opacity < 1,
		opacity,
		depthWrite: opacity >= 1,
	};

	let object;
	if(geometry.index){
		geometry.computeVertexNormals();
		object = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({...common, side: THREE.DoubleSide}));
	}else{
		// A PLY without faces is a point set.
		object = new THREE.Points(geometry, new THREE.PointsMaterial({...common, size: 2, sizeAttenuation: false}));
	}
	object.name = name;
	object.position.copy(center);
	object.visible = entry.visible !== false;

	env.viewer.scene.scene.add(object);
	env.ctx.meshes.push(object);

	env.viewer.onGUILoaded(() => {
		const tree = $("#jstree_scene");
		const nodeId = tree.jstree("create_node", "other", {
			text: name,
			icon: `${Potree.resourcePath}/icons/triangle.svg`,
			data: object,
		}, "last", false, false);
		tree.jstree(object.visible ? "check_node" : "uncheck_node", nodeId);
	});
}

// ---------------------------------------------------------------------------
// 360° images
// ---------------------------------------------------------------------------

async function loadImages360(env, cfg){
	const {viewer, ctx, resolveUrl} = env;
	const baseUrl = resolveUrl(cfg.url || "images360").replace(/\/+$/, "");
	const coordinatesFile = cfg.coordinatesFile || "coordinates.txt";

	const labelSets = (Array.isArray(cfg.labelSets) ? cfg.labelSets : [])
		.filter(set => set && set.url)
		.map((set, i) => ({
			id: String(set.id || `labels${i + 1}`),
			name: String(set.name || set.id || `Labels ${i + 1}`),
			baseUrl: resolveUrl(set.url).replace(/\/+$/, ""),
		}));

	const params = {
		transform: env.transformFor(cfg.crs, "360° images") || IDENTITY,
		coordinatesFile,
		name: "360° images",
	};
	if(labelSets.length > 0){
		if(typeof Potree.Images360.prototype.setDisplayMode === "function"){
			params.labelSets = labelSets;
		}else{
			// Older build: a single label set only.
			params.labelsBaseUrl = labelSets[0].baseUrl;
			if(labelSets.length > 1){
				console.info(`[project] this Potree build supports one 360° label set; using "${labelSets[0].name}"`);
			}
		}
	}

	// Images360Loader does not check the HTTP status of the coordinates file.
	await probeUrl(`${baseUrl}/${coordinatesFile}`);

	const images = await Potree.Images360Loader.load(baseUrl, viewer, params);
	if(images.images.length === 0){
		throw new Error(`${coordinatesFile} lists no images`);
	}
	if(env.preview){
		images.visible = false;
	}else{
		// On a phone the open sidebar leaves ~75 px of render area, which hides
		// most of the 360 control bar: close it when entering a panorama.
		const focus = images.focus.bind(images);
		images.focus = (...args) => {
			if(window.innerWidth <= NARROW_SCREEN_MAX_WIDTH && $("#potree_render_area").css("left") !== "0px"){
				viewer.toggleSidebar();
			}
			return focus(...args);
		};
	}
	viewer.scene.add360Images(images);
	ctx.images360 = images;
	if(!env.preview){
		startImageSearch(viewer);
	}
}

/**
 * File-name search over the scene's images (./image-search.js). Loaded on
 * demand once there are images; a failure only costs the search.
 */
function startImageSearch(viewer){
	import("./image-search.js")
		.then(({installImageSearch}) => installImageSearch(viewer))
		.catch(err => console.warn("[project] image search unavailable:", describeError(err)));
}

// ---------------------------------------------------------------------------
// Preview readiness
// ---------------------------------------------------------------------------

/**
 * Resolves after a rendered frame once nothing is loading and the visible
 * node set has been stable for SETTLE.quietFrames frames and SETTLE.quietMs,
 * at least SETTLE.minMs after `since`; or at `deadline` regardless
 * (`timedOut`, plus `stalled` when the render loop had stopped running).
 * `numNodesLoading === 0` alone is not enough: only a couple of loaded nodes
 * are uploaded to the GPU per frame.
 */
function waitForSettled(viewer, since, deadline){
	return new Promise(resolve => {
		let quietFrames = 0;
		let quietSince = 0;
		let lastSignature = "";
		let finished = false;

		const finish = settled => {
			if(finished){
				return;
			}
			finished = true;
			viewer.removeEventListener("update", onUpdate);
			clearTimeout(fallback);
			const result = {timedOut: !settled, ms: Math.round(performance.now() - since)};
			const onRendered = () => {
				viewer.removeEventListener("render.pass.end", onRendered);
				resolve(result);
			};
			viewer.addEventListener("render.pass.end", onRendered);
		};

		const onUpdate = () => {
			const now = performance.now();
			const pointclouds = viewer.scene.pointclouds.filter(pc => pc.visible);
			const signature = pointclouds.map(pc => `${pc.visibleNodes.length}:${pc.numVisiblePoints}`).join("|");
			const idle = pointclouds.length > 0
				&& pointclouds.every(pc => pc.initialized())
				&& Potree.numNodesLoading === 0
				&& signature === lastSignature;
			lastSignature = signature;

			if(idle){
				if(quietFrames === 0){
					quietSince = now;
				}
				quietFrames++;
			}else{
				quietFrames = 0;
			}

			if(idle && quietFrames >= SETTLE.quietFrames && now - quietSince >= SETTLE.quietMs && now - since >= SETTLE.minMs){
				finish(true);
			}else if(now >= deadline){
				finish(false);
			}
		};

		// If the render loop stalls there are no update events: give up at the
		// deadline anyway, without waiting for a frame. (three.js schedules the
		// next frame after the current one returns, so a single exception in an
		// "update" listener stops Potree's rendering for good.)
		const fallback = setTimeout(() => {
			if(!finished){
				finished = true;
				viewer.removeEventListener("update", onUpdate);
				resolve({timedOut: true, stalled: true, ms: Math.round(performance.now() - since)});
			}
		}, Math.max(0, deadline - performance.now()) + 2000);

		viewer.addEventListener("update", onUpdate);
	});
}

function raceDeadline(promise, deadline){
	if(!Number.isFinite(deadline)){
		return promise;
	}
	return new Promise(resolve => {
		const timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
		promise.then(value => { clearTimeout(timer); resolve(value); });
	});
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

/**
 * fetch() that rejects on HTTP errors and gives up when the server sends
 * nothing for `timeoutMs` (before the headers or between body chunks), so
 * unreachable hosts fail in bounded time while large downloads that keep
 * flowing are not cut off.
 *
 * as: "json" | "arrayBuffer" | "response" (no body read)
 */
async function fetchWithTimeout(url, {as = "arrayBuffer", timeoutMs = LAYER_TIMEOUT_MS, method = "GET", cache = "default"} = {}){
	const controller = new AbortController();
	let timer = null;
	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(() => controller.abort(), timeoutMs);
	};

	arm();
	try{
		const response = await fetch(url, {method, cache, signal: controller.signal});
		if(!response.ok){
			throw new Error(`HTTP ${response.status}${response.statusText ? " " + response.statusText : ""}`);
		}
		if(as === "response"){
			return response;
		}

		let bytes;
		if(response.body){
			const reader = response.body.getReader();
			const chunks = [];
			let length = 0;
			for(;;){
				arm();
				const {done, value} = await reader.read();
				if(done){
					break;
				}
				chunks.push(value);
				length += value.length;
			}
			bytes = new Uint8Array(length);
			let offset = 0;
			for(const chunk of chunks){
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
		}else{
			bytes = new Uint8Array(await response.arrayBuffer());
		}

		if(as === "json"){
			try{
				return JSON.parse(new TextDecoder().decode(bytes));
			}catch(err){
				throw new Error(`invalid JSON (${describeError(err)})`);
			}
		}
		return bytes.buffer;
	}catch(err){
		if(controller.signal.aborted){
			throw new TimeoutError(`no response within ${timeoutMs / 1000} s`);
		}
		if(err instanceof TypeError){
			// fetch's network failure (unreachable host, DNS, CORS, TLS)
			throw new Error(`network error (${err.message}; host unreachable or cross-origin access refused)`);
		}
		throw err;
	}finally{
		clearTimeout(timer);
	}
}

/**
 * Checks that `url` exists (HEAD) and resolves with its size in bytes, or
 * null when the server does not say. Servers that refuse HEAD get the benefit
 * of the doubt.
 */
async function probeUrl(url){
	let response;
	try{
		response = await fetchWithTimeout(url, {as: "response", method: "HEAD"});
	}catch(err){
		if(/^HTTP (405|501)\b/.test(err.message)){
			return null;
		}
		throw err;
	}
	// A compressed response's length is not the file size.
	const encoding = (response.headers.get("content-encoding") || "identity").trim().toLowerCase();
	const length = response.headers.get("content-length");
	return encoding === "identity" && length !== null && /^\d+$/.test(length.trim()) ? Number(length) : null;
}

/** Rejects with a TimeoutError after `ms`; `promise` itself keeps running. */
function withTimeout(promise, ms, message = `did not finish within ${ms / 1000} s`){
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
		promise.then(
			value => { clearTimeout(timer); resolve(value); },
			err => { clearTimeout(timer); reject(err); });
	});
}

/**
 * Waits for an optional layer at most LAYER_TIMEOUT_MS; reports a failure or
 * a timeout as a notice. Work that is merely slow keeps going: if it
 * completes after the timeout, its notice is withdrawn.
 */
async function trackLayer(ctx, label, promise){
	try{
		await withTimeout(promise, LAYER_TIMEOUT_MS, `did not finish loading within ${LAYER_TIMEOUT_MS / 1000} s`);
	}catch(err){
		const dismiss = notify(ctx, `${label} unavailable: ${describeError(err)}`);
		if(err instanceof TimeoutError){
			promise.then(() => {
				dismiss();
				console.info(`[project] ${label} finished loading after the timeout`);
			}, () => {});
		}
	}
}

// ---------------------------------------------------------------------------
// Notices and fatal errors
// ---------------------------------------------------------------------------

function warn(ctx, message){
	ctx.warnings.push(message);
	console.warn(`[project] ${message}`);
}

/**
 * Console warning plus a small dismissible notice (not in preview mode).
 * Returns a function that removes the notice.
 */
function notify(ctx, message){
	warn(ctx, message);
	if(ctx.preview){
		return () => {};
	}

	let list = document.querySelector(".pv-notices");
	if(!list){
		list = document.createElement("div");
		list.className = "pv-notices";
		list.setAttribute("role", "status");
		list.setAttribute("aria-live", "polite");
		document.body.append(list);
	}

	const notice = document.createElement("div");
	notice.className = "pv-notice";
	const text = document.createElement("span");
	text.textContent = message;
	const close = document.createElement("button");
	close.type = "button";
	close.className = "pv-notice-close";
	close.setAttribute("aria-label", "Dismiss");
	close.textContent = "×";
	close.addEventListener("click", () => notice.remove());
	notice.append(text, close);
	list.append(notice);

	return () => notice.remove();
}

function showFatalError(message){
	const backLink = document.querySelector(".project-backlink");
	const panel = document.createElement("div");
	panel.className = "pv-error";
	panel.setAttribute("role", "alert");

	const card = document.createElement("div");
	card.className = "pv-error-card";
	const title = document.createElement("h2");
	title.textContent = "This project could not be loaded";
	const detail = document.createElement("p");
	detail.textContent = message;
	const hint = document.createElement("p");
	hint.className = "pv-error-hint";
	hint.textContent = "The browser console has more details.";
	const link = document.createElement("a");
	link.href = backLink ? backLink.href : "../";
	link.textContent = "← Back to projects";
	card.append(title, detail, hint, link);
	panel.append(card);
	document.body.append(panel);
}

function injectStyles(){
	if(document.getElementById("pv-styles")){
		return;
	}
	const style = document.createElement("style");
	style.id = "pv-styles";
	style.textContent = `
		.pv-notices{
			position: fixed; top: 48px; right: 10px; z-index: 10002;
			display: flex; flex-direction: column; gap: 6px; align-items: flex-end;
			max-width: min(420px, calc(100vw - 76px)); /* clear of the quick-button column */
			font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
		}
		.pv-notice{
			display: flex; gap: 8px; align-items: flex-start;
			padding: 7px 8px 7px 12px; border-radius: 6px;
			background: rgba(52, 38, 12, 0.92); color: #fbe7c0;
			border: 1px solid rgba(240, 180, 70, 0.55);
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
			overflow-wrap: anywhere;
		}
		.pv-notice-close{
			flex: none; width: 24px; height: 24px; padding: 0; margin: -2px 0;
			border: 0; border-radius: 4px; background: transparent; color: inherit;
			font-size: 18px; line-height: 24px; cursor: pointer;
		}
		.pv-notice-close:hover, .pv-notice-close:focus-visible{ background: rgba(255, 255, 255, 0.15); }
		.pv-error{
			position: fixed; inset: 0; z-index: 20000;
			display: flex; align-items: center; justify-content: center; padding: 16px;
			background: rgba(10, 12, 16, 0.78);
			font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
		}
		.pv-error-card{
			max-width: 560px; padding: 22px 26px; border-radius: 10px;
			background: #1d2128; color: #e6e9ee; border: 1px solid #c0504d;
			box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); overflow-wrap: anywhere;
		}
		.pv-error-card h2{ margin: 0 0 10px; font-size: 18px; color: #ff9d9a; }
		.pv-error-card p{ margin: 0 0 10px; }
		.pv-error-card .pv-error-hint{ color: #9aa3ae; font-size: 13px; }
		.pv-error-card a{ color: #8ab4f8; }
		html.project-preview .pv-notices,
		html.project-preview #message_listing,
		html.project-preview #potree_description,
		html.project-preview #potree_quick_buttons{ display: none !important; }
	`;
	document.head.append(style);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function describeError(err){
	if(!err){
		return "unknown error";
	}
	return err.message || String(err);
}

/** Last path segment of `url`, percent-decoded when it is valid escaping (labels only). */
function basename(url){
	if(!url){
		return "";
	}
	const last = String(url).split(/[?#]/)[0].split("/").filter(Boolean).pop() || "";
	try{
		return decodeURIComponent(last);
	}catch(err){
		return last; // e.g. a bare "%" in "50%_done.gpkg"
	}
}

function positiveNumber(value, fallback){
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isVector3(value){
	return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}
