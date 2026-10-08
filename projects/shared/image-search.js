/**
 * File-name search over the images of a project page: the 360° panoramas of
 * every Images360 set in the scene (the main case) and oriented photos
 * (OrientedImages).
 *
 * A compact field sits at the top left of the 3D view, right of Potree's quick
 * buttons and clear of the description text and the page's "← Projects" link;
 * when there is too little room (or on a narrow screen) it collapses into a
 * button below the quick buttons that expands into the field. Typing lists
 * the best matching images — exact name > prefix > frame number (e.g. "758"
 * finds 000758) > substring > every typed letter/digit group in order — with
 * the matched part marked. A pasted path or URL works as well, also cut off.
 * Choosing one flies the camera to an oblique view of the image along the
 * street, from a side with a clear line of sight onto it, and flashes the
 * image's own marker (its 360° sphere, or a photo's frame) for a few seconds;
 * while a panorama is open, choosing another image opens that one instead (the
 * photo/label display mode is the set's and is kept). The result line offers
 * "Open panorama", as does Enter again.
 *
 * Keyboard: "/" focuses the field, ↑/↓ move through the candidates, Enter goes
 * to the image (again: opens it), Esc closes the list, then clears, then leaves.
 *
 * Usage: `installImageSearch(viewer)` — once per viewer; later calls return
 * the same instance. The control appears while the scene holds at least one
 * image and follows image sets that are added or removed later.
 */

const STYLE_ID = "pv-image-search-styles";

/** Candidates listed at most. */
const MAX_RESULTS = 8;
/** Pause in typing before the list is updated. */
const DEBOUNCE_MS = 80;
/** Viewports up to this width (px) get the collapsed control (same breakpoint as project-viewer.js). */
const NARROW_SCREEN_MAX_WIDTH = 700;
/** Narrower than this between its neighbours, the field collapses into its button as well. */
const MIN_FIELD_WIDTH = 150;
const MAX_FIELD_WIDTH = 340;
/** The candidate list may be wider than the field: it opens below the row of top controls. */
const MAX_POPUP_WIDTH = 420;
/** Below this field width the shorter placeholder is used. */
const SHORT_PLACEHOLDER_WIDTH = 250;
const EDGE = 10;
const GAP = 8;
/** Height of the field's row; anything overlapping it at the top of the view is a neighbour. */
const ROW_HEIGHT = 44;
/** Room (px) the result line takes below the field, with its margin (it is taller on touch screens). */
const FOUND_ROW_EXTENT = 78;

/**
 * Views onto a found image, best first: `back` metres from it horizontally,
 * along the street, and `up` metres above it. The first is the usual oblique
 * view (about 26 m away, 39° down); the next ones look down more steeply,
 * over whatever stands in the way, and the last one from lower, under a tree
 * canopy. Each is tried on the preferred side of the image, then on the
 * other; the first with a clear line of sight is taken (see lineOfSight).
 */
const APPROACHES = [
	{back: 20, up: 16},
	{back: 12, up: 20},
	{back: 5, up: 24},
	{back: 20, up: 8},
];
const FLIGHT_MS = 1200;

/**
 * Line of sight from a camera position onto an image: rays to the image and
 * to 8 points around it (`spread` metres across the line of sight, a 3 × 3
 * grid) are tested against the points of the visible point clouds that are
 * loaded. A ray is blocked by `minHits` points within `radius` of it (fewer
 * are twigs or loose leaves); points in the last `skipNear` metres before
 * the image (the mapping vehicle, the road under it) do not count. The view
 * is clear while at most `maxBlocked` of the 9 rays are blocked: a tree crown
 * over the image or vegetation around the camera blocks (nearly) all of them,
 * while wires, a pole or the trees along one side of the street block some.
 * (Calibrated on views of Vevey, Ollon and streetview-ne judged by eye.)
 */
const LOS = {spread: 1.5, radius: 0.2, minHits: 10, skipNear: 2.5, maxBlocked: 5};

/**
 * After the flight, once the point cloud around the new view has loaded (no
 * node loading for `quietFrames` frames, at most `maxWaitMs`), the line of
 * sight is checked again with the finer points; when it is blocked, the
 * camera moves on to the best other view over `moveMs`.
 */
const VERIFY = {quietFrames: 10, maxWaitMs: 4000, moveMs: 800};

/** Images within this distance (m) of a panorama are its neighbourhood, whose main axis is the street. */
const NEIGHBOUR_RADIUS = 15;
/**
 * The "course" of a set's images gives the street axis once it agrees with
 * their neighbourhoods: checked on up to `samples` images on straight
 * stretches (`straight`: elongation of the neighbourhood), at least
 * `minSamples` of them, with an agreement (mean resultant length of the axis
 * differences) of at least `agreement`.
 */
const HEADING = {samples: 400, minSamples: 8, straight: 0.9, agreement: 0.8};
/** A neighbourhood at least this elongated gives the street axis when the course cannot. */
const MIN_STREET_ELONGATION = 0.75;
/** Images further apart than this (m) in file-name order are not taken as the survey track (a gap or a new run). */
const MAX_TRACK_SPAN = 60;

const FLASH = {
	/** How long the marker flashes once the camera has arrived (the flight itself takes FLIGHT_MS). */
	durationMs: 3000,
	/** One on/off cycle. */
	periodMs: 500,
	color: 0xffd23f,
	renderOrder: 1e6,
};

const DEG = Math.PI / 180;


/** A run of letters or a run of digits: the "tokens" of a query. */
const TOKEN_PATTERN = /[\p{L}\p{M}]+|\p{N}+/gu;

const instances = new WeakMap();
let instanceCount = 0;

/**
 * Adds the image search to the page of `viewer` (not in preview mode).
 * @returns {ImageSearch|null} the instance; null when there is no render area or in preview mode.
 */
export function installImageSearch(viewer){
	if(!viewer || !viewer.renderArea || document.documentElement.classList.contains("project-preview")){
		return null;
	}
	let search = instances.get(viewer);
	if(!search){
		search = new ImageSearch(viewer);
		instances.set(viewer, search);
	}
	return search;
}

// ---------------------------------------------------------------------------
// Index and matching
// ---------------------------------------------------------------------------

/** The image sets of `scene` that hold at least one image, in a common shape. */
function collectSources(scene){
	const sources = [];
	for(const set of scene.images360 || []){
		if(set && Array.isArray(set.images) && set.images.length > 0){
			sources.push({
				kind: "360",
				set,
				images: set.images,
				name: set.name || "360° images",
				fileOf: image => String(image.file),
				positionOf: image => Array.isArray(image.position) ? image.position : image.mesh.position.toArray(),
			});
		}
	}
	for(const set of scene.orientedImages || []){
		if(set && Array.isArray(set.images) && set.images.length > 0){
			sources.push({
				kind: "oriented",
				set,
				images: set.images,
				name: set.name || "Photos",
				fileOf: image => String(image.id),
				positionOf: image => image.position.toArray(),
			});
		}
	}
	return sources;
}

/**
 * One entry per image, with the lowercase forms the matcher compares
 * precomputed. `path` is the file relative to the set's common folder (usually
 * just the file name), `name` its last segment. The source keeps that folder
 * (`lfolder`, see urlPath) to recognise pasted paths.
 */
function buildIndex(sources){
	const entries = [];
	for(const source of sources){
		const files = source.images.map(source.fileOf);
		const folder = commonFolder(files);
		source.lfolder = urlPath(folder.toLowerCase());
		files.forEach((file, index) => {
			const path = file.slice(folder.length);
			const name = path.slice(path.lastIndexOf("/") + 1);
			const lpath = path.toLowerCase();
			const lname = name.toLowerCase();
			const dot = lname.lastIndexOf(".");
			const extLength = dot > 0 ? lname.length - dot : 0;
			entries.push({
				source,
				image: source.images[index],
				index,
				path,
				name,
				lpath,
				lname,
				segments: lpath.split("/").length,
				extLength,
				numbers: digitRuns(lname, lname.length - extLength),
				// Lowercasing a few non-ASCII letters changes the length; then the
				// match offsets do not fit the original text and nothing is marked.
				markable: lpath.length === path.length,
				order: entries.length,
			});
		});
	}
	return entries;
}

/** The longest folder prefix ("…/") shared by all `files`. */
function commonFolder(files){
	if(files.length === 0){
		return "";
	}
	let prefix = files[0].slice(0, files[0].lastIndexOf("/") + 1);
	for(const file of files){
		while(prefix && !file.startsWith(prefix)){
			prefix = prefix.slice(0, prefix.lastIndexOf("/", prefix.length - 2) + 1);
		}
		if(!prefix){
			break;
		}
	}
	return prefix;
}

/** The digit runs of `text` before `end`, keyed by their value without leading zeros. */
function digitRuns(text, end){
	const runs = [];
	const pattern = /\d+/g;
	let match;
	while((match = pattern.exec(text)) !== null && match.index < end){
		const stop = Math.min(match.index + match[0].length, end);
		runs.push({key: stripZeros(text.slice(match.index, stop)), start: match.index, end: stop, last: false});
	}
	if(runs.length > 0){
		runs[runs.length - 1].last = true;
	}
	return runs;
}

function stripZeros(digits){
	return digits.replace(/^0+(?=\d)/, "");
}

function normalizeQuery(text){
	return String(text).trim().toLowerCase().replace(/\\/g, "/").replace(/\s+/g, " ");
}

function isAlphanumeric(char){
	return /[\p{L}\p{M}\p{N}]/u.test(char);
}

function isDigit(char){
	return char >= "0" && char <= "9";
}

/** True when `at` starts a word of `text`: after a separator or at a letter/digit change. */
function startsWord(text, at){
	if(at === 0){
		return true;
	}
	const before = text[at - 1];
	return !isAlphanumeric(before) || isDigit(before) !== isDigit(text[at]);
}

/** The parts of a (lowercase) query text that the matcher compares. */
function queryParts(text){
	return {
		text,
		tokens: text.match(TOKEN_PATTERN) || [],
		numberKey: /^\d+$/.test(text) ? stripZeros(text) : null,
	};
}

/** `url` without its scheme and host ("http://host:8080/a/" → "/a/") or a leading "./". */
function urlPath(url){
	return url.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/, "").replace(/^\.\//, "");
}

/**
 * True when `lead`, the leading folders of a pasted path ("…/"), can be (the
 * end of) `folder`, a set's common folder as urlPath() gives it, or more of
 * the same address: "images360/", "jects/x/images360/" and
 * "https://elsewhere/potree/projects/x/images360/" all fit the folder of
 * "http://host/projects/x/images360/…" — and of "./images360/…". Without a
 * folder there is nothing to compare, and any lead fits.
 */
function folderFits(folder, lead){
	const path = urlPath(lead);
	return !folder || folder.endsWith(path) || path.endsWith(folder);
}

/**
 * The part of a path query to compare with `entry`'s path. A pasted path or
 * URL usually starts with folders that the entry's path leaves out (the set's
 * common folder, the site's address), and may be cut off anywhere: when those
 * leading segments fit the set's folder, only the last ones are compared — as
 * many as the entry's path has. A folder alone ("images360/") so matches
 * every image in it. Remembered while consecutive entries share their set
 * and segment count.
 */
function pathParts(entry, query){
	const memo = query.memo;
	if(memo.source !== entry.source || memo.segments !== entry.segments){
		memo.source = entry.source;
		memo.segments = entry.segments;
		const segments = query.text.split("/");
		const cut = segments.length - entry.segments;
		memo.parts = cut > 0 && folderFits(entry.source.lfolder, segments.slice(0, cut).join("/") + "/")
			? queryParts(segments.slice(cut).join("/"))
			: query;
	}
	return memo.parts;
}

/**
 * How `entry` matches the query, or null. Lower tiers rank first:
 * 0 exact (name, name without extension, or a longer path ending in the
 * entry's path), 1 prefix, 2 frame number (a digit run of the same value),
 * 3 substring, 4 all tokens in order. `sub`, `at` and `length` break ties.
 * `ranges` are [start, end) offsets into the text shown for the entry.
 */
function matchEntry(entry, query){
	const field = query.usePath ? entry.lpath : entry.lname;
	const {text, tokens, numberKey} = query.usePath ? pathParts(entry, query) : query;

	if(field === text
		|| (text.length === field.length - entry.extLength && field.startsWith(text))
		|| (query.usePath && query.text.endsWith("/" + field))){
		return {entry, tier: 0, sub: 0, at: 0, length: field.length, ranges: [[0, Math.min(text.length, field.length)]]};
	}

	const at = field.indexOf(text);
	if(at === 0){
		return {entry, tier: 1, sub: 0, at, length: field.length, ranges: [[0, text.length]]};
	}

	if(numberKey !== null){
		// From the last digit run, which is usually the frame number.
		for(let i = entry.numbers.length - 1; i >= 0; i--){
			const run = entry.numbers[i];
			if(run.key === numberKey){
				return {entry, tier: 2, sub: run.last ? 0 : 1, at: run.start, length: field.length, ranges: [[run.start, run.end]]};
			}
		}
	}

	if(at > 0){
		return {entry, tier: 3, sub: startsWord(field, at) ? 0 : 1, at, length: field.length, ranges: [[at, at + text.length]]};
	}

	if(tokens.length > 1 || (tokens.length === 1 && tokens[0] !== text)){
		const ranges = [];
		let from = 0;
		for(const token of tokens){
			const found = field.indexOf(token, from);
			if(found < 0){
				return null;
			}
			ranges.push([found, found + token.length]);
			from = found + token.length;
		}
		return {entry, tier: 4, sub: from - ranges[0][0], at: ranges[0][0], length: field.length, ranges};
	}

	return null;
}

function compareMatches(a, b){
	return a.tier - b.tier || a.sub - b.sub || a.at - b.at || a.length - b.length || a.entry.order - b.entry.order;
}

/**
 * Ranks `entries` against `text`.
 * @returns {{query: string, usePath: boolean, total: number, results: Array}} the best `limit` matches, best first.
 */
function findImages(entries, text, limit = MAX_RESULTS){
	const normalized = normalizeQuery(text);
	const query = {
		...queryParts(normalized),
		// A "/" means a (partial) path: compare with the path instead of the file name.
		usePath: normalized.includes("/"),
		memo: {}, // see pathParts()
	};
	const results = [];
	let total = 0;
	if(normalized){
		for(const entry of entries){
			const match = matchEntry(entry, query);
			if(!match){
				continue;
			}
			total++;
			if(results.length === limit && compareMatches(match, results[limit - 1]) >= 0){
				continue;
			}
			let i = results.length;
			while(i > 0 && compareMatches(match, results[i - 1]) < 0){
				i--;
			}
			results.splice(i, 0, match);
			if(results.length > limit){
				results.pop();
			}
		}
	}
	return {query: normalized, usePath: query.usePath, total, results};
}

// ---------------------------------------------------------------------------
// Camera approach
// ---------------------------------------------------------------------------

/** [x, y] scaled to length 1, or null for a zero vector. */
function unit(x, y){
	const length = Math.hypot(x, y);
	return length > 1e-9 ? [x / length, y / length] : null;
}

/** The horizontal unit vector at `angle` (radians, counter-clockwise from east). */
function axisAt(angle){
	return [Math.cos(angle), Math.sin(angle)];
}

/** The horizontal positions of a 360° set's images on a grid of NEIGHBOUR_RADIUS cells, built on first use. */
function neighbourGrid(source){
	if(!source.grid){
		const positions = source.images.map(source.positionOf);
		const cells = new Map();
		positions.forEach(([x, y], index) => {
			const key = `${Math.floor(x / NEIGHBOUR_RADIUS)},${Math.floor(y / NEIGHBOUR_RADIUS)}`;
			const cell = cells.get(key);
			if(cell){
				cell.push(index);
			}else{
				cells.set(key, [index]);
			}
		});
		source.grid = {positions, cells};
	}
	return source.grid;
}

/**
 * Main horizontal axis of the images within NEIGHBOUR_RADIUS of image `index`
 * (the principal component of their positions): the street, where they line
 * up along one, whatever order the set lists them in.
 * @returns {{angle: number, elongation: number}|null} `angle` of the axis
 *     (radians, mod π); `elongation` 1 − minor/major variance, 1 on a straight line.
 */
function neighbourhoodAxis(source, index){
	const {positions, cells} = neighbourGrid(source);
	const [x0, y0] = positions[index];
	const cellX = Math.floor(x0 / NEIGHBOUR_RADIUS);
	const cellY = Math.floor(y0 / NEIGHBOUR_RADIUS);
	let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
	for(let i = -1; i <= 1; i++){
		for(let j = -1; j <= 1; j++){
			for(const other of cells.get(`${cellX + i},${cellY + j}`) || []){
				// Relative to the image: map coordinates are too large for sums of squares.
				const dx = positions[other][0] - x0;
				const dy = positions[other][1] - y0;
				if(dx * dx + dy * dy <= NEIGHBOUR_RADIUS * NEIGHBOUR_RADIUS){
					n++;
					sx += dx;
					sy += dy;
					sxx += dx * dx;
					syy += dy * dy;
					sxy += dx * dy;
				}
			}
		}
	}
	if(n < 3){
		return null;
	}
	const vxx = sxx / n - (sx / n) ** 2;
	const vyy = syy / n - (sy / n) ** 2;
	const vxy = sxy / n - (sx / n) * (sy / n);
	const half = (vxx + vyy) / 2;
	const deviation = Math.hypot((vxx - vyy) / 2, vxy);
	const major = half + deviation;
	if(major < 0.25){
		return null; // a stop: the images are all within about a metre
	}
	return {angle: Math.atan2(2 * vxy, vxx - vyy) / 2, elongation: 1 - (half - deviation) / major};
}

/**
 * How the "course" of a 360° set's images (the heading recorded with each
 * panorama) maps to the street axis, learnt once per set from images on
 * straight stretches: course is a compass bearing or an angle from east, plus
 * a constant offset (a camera mounted facing backwards, the grid convergence
 * between coordinate systems). Null when the course does not follow the
 * streets (missing, constant or noisy values).
 * @returns {{toAngle: function(number): number, offset: number}|null}
 */
function headingModel(source){
	if(source.headingModel !== undefined){
		return source.headingModel;
	}
	const conventions = [
		course => Math.PI / 2 - course * DEG, // compass bearing: clockwise from north
		course => course * DEG,               // counter-clockwise from east
	];
	// Axes are angles mod π: average the doubled differences.
	const sums = conventions.map(() => ({cos: 0, sin: 0}));
	let n = 0;
	const step = Math.max(1, Math.floor(source.images.length / HEADING.samples));
	for(let index = 0; index < source.images.length; index += step){
		const course = Number(source.images[index].course);
		const street = Number.isFinite(course) ? neighbourhoodAxis(source, index) : null;
		if(!street || street.elongation < HEADING.straight){
			continue;
		}
		n++;
		conventions.forEach((toAngle, k) => {
			const difference = 2 * (street.angle - toAngle(course));
			sums[k].cos += Math.cos(difference);
			sums[k].sin += Math.sin(difference);
		});
	}
	let model = null;
	if(n >= HEADING.minSamples){
		let best = 0;
		conventions.forEach((toAngle, k) => {
			const agreement = Math.hypot(sums[k].cos, sums[k].sin) / n;
			if(agreement >= HEADING.agreement && agreement > best){
				best = agreement;
				model = {toAngle, offset: Math.atan2(sums[k].sin, sums[k].cos) / 2};
			}
		});
	}
	source.headingModel = model;
	return model;
}

/**
 * Horizontal direction of the survey track at image `index` from its
 * neighbours in file-name order (frame numbers: the capture order, unlike the
 * order of some coordinates files). Pairs that span less than half a metre
 * (a stop) or more than MAX_TRACK_SPAN (a gap, another run) are skipped.
 */
function nameOrderTrack(source, index){
	if(!source.trackRank){
		const files = source.images.map(source.fileOf);
		source.track = files.map((file, i) => i).sort((a, b) => files[a] < files[b] ? -1 : files[a] > files[b] ? 1 : a - b);
		source.trackRank = new Int32Array(files.length);
		source.track.forEach((image, rank) => { source.trackRank[image] = rank; });
	}
	const {track} = source;
	const k = source.trackRank[index];
	const last = track.length - 1;
	for(const [from, to] of [[k - 3, k + 3], [k - 2, k + 2], [k - 1, k + 1], [k - 1, k], [k, k + 1]]){
		const a = Math.max(0, from);
		const b = Math.min(last, to);
		if(a === b){
			continue;
		}
		const p = source.positionOf(source.images[track[a]]);
		const q = source.positionOf(source.images[track[b]]);
		const span = Math.hypot(q[0] - p[0], q[1] - p[1]);
		if(span >= 0.5 && span <= MAX_TRACK_SPAN){
			return unit(q[0] - p[0], q[1] - p[1]);
		}
	}
	return null;
}

/**
 * The horizontal axis to view an image along, or null.
 * - A panorama: the street, from the image's own heading (its course, once
 *   the set's courses are known to follow the streets; unless it is more than
 *   45° off a straight neighbourhood), else from its neighbourhood, else from
 *   its neighbours in file-name order. Either sense.
 * - An oriented photo: the way the photo looks (`fixed`: from behind the
 *   photo's camera), unless it looks (almost) straight down.
 * @returns {{axis: number[], fixed: boolean}|null}
 */
function approachAxis(entry){
	const {source, image, index} = entry;
	if(source.kind !== "360"){
		const from = image.position;
		const to = image.mesh && image.mesh.position; // the photo's plane, in front of its camera
		if(!from || !to){
			return null;
		}
		const [dx, dy, dz] = [to.x - from.x, to.y - from.y, to.z - from.z];
		const horizontal = Math.hypot(dx, dy);
		return horizontal >= 0.25 * Math.hypot(dx, dy, dz) ? {axis: [dx / horizontal, dy / horizontal], fixed: true} : null;
	}
	const model = headingModel(source);
	const course = Number(image.course);
	const street = neighbourhoodAxis(source, index);
	if(model && Number.isFinite(course)){
		const axis = axisAt(model.toAngle(course) + model.offset);
		// An odd heading on a plainly straight street (the vehicle manoeuvring,
		// a sensor glitch) gives way to the street.
		const odd = street && street.elongation >= HEADING.straight
			&& Math.abs(axis[0] * Math.cos(street.angle) + axis[1] * Math.sin(street.angle)) < Math.SQRT1_2;
		return {axis: odd ? axisAt(street.angle) : axis, fixed: false};
	}
	if(street && street.elongation >= MIN_STREET_ELONGATION){
		return {axis: axisAt(street.angle), fixed: false};
	}
	const track = nameOrderTrack(source, index);
	return track ? {axis: track, fixed: false} : null;
}

/**
 * Camera positions to view `target` (the image of `entry`) from, best first:
 * APPROACHES along the image's axis (see approachAxis), on the side that keeps
 * the user facing about the way they look now (the current horizontal viewing
 * direction), then on the other side. Without an axis, along the current
 * viewing direction.
 */
function approachPositions(entry, target, view){
	const [x, y, z] = target;
	const direction = view.direction;
	let forward = (Math.abs(direction.z) < 0.98 && unit(direction.x, direction.y))
		// Looking straight down: come from where the camera is.
		|| unit(x - view.position.x, y - view.position.y)
		|| [0, 1];
	const heading = approachAxis(entry);
	if(heading){
		const [ax, ay] = heading.axis;
		const sense = heading.fixed || ax * forward[0] + ay * forward[1] >= 0 ? 1 : -1;
		forward = [ax * sense, ay * sense];
	}
	const positions = [];
	for(const {back, up} of APPROACHES){
		for(const side of [1, -1]){
			positions.push([x - forward[0] * back * side, y - forward[1] * back * side, z + up]);
		}
	}
	return positions;
}

/**
 * Tests the line of sight from `eye` onto `target` (see LOS) against the
 * loaded points of the visible point clouds, skipping points of hidden
 * classifications. Cheap: only octree nodes near the rays are visited.
 * @returns {{clear: boolean, score: number}} `score` ranks views when none is
 *     clear: the blocked rays, the central one counting 1.5.
 */
function lineOfSight(pointclouds, eye, target){
	const length = Math.hypot(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
	const reach = length - LOS.skipNear;
	if(!(reach > 0)){
		return {clear: true, score: 0};
	}
	// A frame along the line of sight: f forward, a across (horizontal), b up.
	const f = [(target[0] - eye[0]) / length, (target[1] - eye[1]) / length, (target[2] - eye[2]) / length];
	const across = unit(f[1], -f[0]) || [1, 0];
	const a = [across[0], across[1], 0];
	const b = [a[1] * f[2] - a[2] * f[1], a[2] * f[0] - a[0] * f[2], a[0] * f[1] - a[1] * f[0]];
	const r2 = LOS.radius * LOS.radius;
	const hits = new Uint32Array(9);

	for(const pointcloud of pointclouds){
		if(!pointcloud || !pointcloud.visible || !pointcloud.root || !pointcloud.matrixWorld){
			continue;
		}
		// Octree coordinates p map to the world as M p + t: the frame's axes in
		// octree coordinates are Mᵀu, plus the offset (t − eye)·u.
		const m = pointcloud.matrixWorld.elements;
		const [F, A, B] = [f, a, b].map(u => [
			m[0] * u[0] + m[1] * u[1] + m[2] * u[2],
			m[4] * u[0] + m[5] * u[1] + m[6] * u[2],
			m[8] * u[0] + m[9] * u[1] + m[10] * u[2],
			(m[12] - eye[0]) * u[0] + (m[13] - eye[1]) * u[1] + (m[14] - eye[2]) * u[2],
		]);
		// Points of hidden classes are not drawn (the material's lookup table has alpha 0 for them).
		const texture = pointcloud.material && pointcloud.material.classificationTexture;
		const lookup = texture && texture.image && texture.image.data;
		const hidden = lookup && lookup.some((value, i) => i % 4 === 3 && value === 0) ? lookup : null;

		const stack = [pointcloud.root];
		while(stack.length > 0){
			const node = stack.pop();
			const geometryNode = node.geometryNode || node;
			const box = geometryNode.boundingBox;
			const geometry = geometryNode.geometry;
			const position = geometry && geometry.attributes && geometry.attributes.position;
			// A node is loaded after its parent and unloaded with it.
			if(!box || !position){
				continue;
			}
			const {min, max} = box;
			// The box's extent along each axis of the frame, from its 8 corners.
			const extent = [F, A, B].map(([ux, uy, uz, offset]) => {
				const low = offset + Math.min(min.x * ux, max.x * ux) + Math.min(min.y * uy, max.y * uy) + Math.min(min.z * uz, max.z * uz);
				const high = offset + Math.max(min.x * ux, max.x * ux) + Math.max(min.y * uy, max.y * uy) + Math.max(min.z * uz, max.z * uz);
				return [low, high];
			});
			// The rays spread out with the depth: at the box's far end they are this far from the axis.
			const lateral = LOS.spread * Math.min(1, extent[0][1] / length) + LOS.radius;
			if(extent[0][1] <= 0 || extent[0][0] >= reach
				|| extent[1][0] > lateral || extent[1][1] < -lateral
				|| extent[2][0] > lateral || extent[2][1] < -lateral){
				continue;
			}

			// Positions are relative to the box's minimum.
			const kf = F[3] + min.x * F[0] + min.y * F[1] + min.z * F[2];
			const ka = A[3] + min.x * A[0] + min.y * A[1] + min.z * A[2];
			const kb = B[3] + min.x * B[0] + min.y * B[1] + min.z * B[2];
			const xyz = position.array;
			const classes = hidden && geometry.attributes.classification ? geometry.attributes.classification.array : null;
			for(let i = 0, p = 0; i < xyz.length; i += 3, p++){
				const x = xyz[i], y = xyz[i + 1], z = xyz[i + 2];
				const depth = x * F[0] + y * F[1] + z * F[2] + kf;
				if(depth <= 0 || depth >= reach){
					continue;
				}
				// The rays fan out from the eye to their points around the target.
				const step = LOS.spread * depth / length;
				const pa = x * A[0] + y * A[1] + z * A[2] + ka;
				if(pa > step + LOS.radius || pa < -step - LOS.radius){
					continue;
				}
				const pb = x * B[0] + y * B[1] + z * B[2] + kb;
				if(pb > step + LOS.radius || pb < -step - LOS.radius){
					continue;
				}
				if(classes && hidden[4 * (classes[p] & 255) + 3] === 0){
					continue;
				}
				for(let row = 0; row < 3; row++){
					const db = pb - (row - 1) * step;
					if(db * db > r2){
						continue;
					}
					for(let column = 0; column < 3; column++){
						const da = pa - (column - 1) * step;
						if(da * da + db * db <= r2){
							hits[3 * row + column]++;
						}
					}
				}
			}

			const children = node.children || [];
			for(let i = 0; i < 8; i++){
				if(children[i]){
					stack.push(children[i]);
				}
			}
		}
	}

	let blocked = 0;
	hits.forEach(count => {
		if(count >= LOS.minHits){
			blocked++;
		}
	});
	return {clear: blocked <= LOS.maxBlocked, score: blocked + (hits[4] >= LOS.minHits ? 0.5 : 0)};
}

/**
 * The first of `positions` with a clear line of sight onto `target`, else
 * the least blocked one (the earliest of equals).
 * @returns {{index: number, position: number[], sight: {clear, score}}}
 */
function bestView(pointclouds, positions, target){
	let best = null;
	for(let index = 0; index < positions.length; index++){
		const sight = lineOfSight(pointclouds, positions[index], target);
		if(sight.clear){
			return {index, position: positions[index], sight};
		}
		if(!best || sight.score < best.sight.score){
			best = {index, position: positions[index], sight};
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// Flash
// ---------------------------------------------------------------------------

/**
 * Flashes the image's own marker in colour, at its own shape and size: a 360°
 * image's sphere blinks in FLASH.color; an oriented photo's frame blinks. The sphere's flash is
 * an exact copy of it (same geometry and placement) in the overlay scene,
 * which is drawn after the eye-dome-lighting composite and so is not painted
 * over by the points; the image's own sphere is left untouched, so hovering
 * and clicking it keep working while it flashes.
 * @returns {{update(elapsedMs, reducedMotion): boolean, dispose()}|null}
 *   update() returns false once the flash is over; dispose() removes it.
 */
function createFlash(viewer, entry){
	const {source, image} = entry;
	const total = FLIGHT_MS + FLASH.durationMs;
	const blink = (elapsed, reducedMotion) => {
		// Reduced motion: a slower blink.
		const period = reducedMotion ? FLASH.periodMs * 2 : FLASH.periodMs;
		return (elapsed % period) < period / 2;
	};

	if(source.kind === "360" && image.mesh){
		const mesh = image.mesh;
		const material = mesh.material.clone();
		material.color.setHex(FLASH.color);
		material.opacity = 1;
		material.depthTest = false;
		material.depthWrite = false;
		const copy = mesh.clone();
		copy.material = material;
		mesh.updateMatrixWorld();
		mesh.getWorldPosition(copy.position);
		mesh.getWorldQuaternion(copy.quaternion);
		copy.scale.copy(mesh.scale);
		copy.renderOrder = FLASH.renderOrder;
		copy.frustumCulled = false;
		delete copy.image360; // not a pick target
		const parent = viewer.scene.sceneOverlay || viewer.scene.scene;
		parent.add(copy);
		return {
			update(elapsed, reducedMotion){
				if(elapsed >= total){
					return false;
				}
				copy.visible = blink(elapsed, reducedMotion);
				return true;
			},
			dispose(){
				parent.remove(copy);
				material.dispose();
			},
		};
	}

	const frame = image.line && image.line.material && image.line.material.color;
	if(source.kind === "oriented" && frame){
		const baseColor = frame.getHex();
		return {
			update(elapsed, reducedMotion){
				if(elapsed >= total){
					frame.setHex(baseColor);
					return false;
				}
				frame.setHex(blink(elapsed, reducedMotion) ? FLASH.color : baseColor);
				return true;
			},
			dispose(){
				frame.setHex(baseColor);
			},
		};
	}

	return null;
}

// ---------------------------------------------------------------------------
// DOM helpers and styles
// ---------------------------------------------------------------------------

function element(tag, className, text){
	const node = document.createElement(tag);
	if(className){
		node.className = className;
	}
	if(text !== undefined){
		node.textContent = text;
	}
	return node;
}

function magnifierIcon(){
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 20 20");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	svg.classList.add("pv-isearch-icon");
	const circle = document.createElementNS(ns, "circle");
	circle.setAttribute("cx", "8.5");
	circle.setAttribute("cy", "8.5");
	circle.setAttribute("r", "5.5");
	const handle = document.createElementNS(ns, "path");
	handle.setAttribute("d", "M12.6 12.6 L17 17");
	for(const shape of [circle, handle]){
		shape.setAttribute("fill", "none");
		shape.setAttribute("stroke", "currentColor");
		shape.setAttribute("stroke-width", "2");
		shape.setAttribute("stroke-linecap", "round");
		svg.append(shape);
	}
	return svg;
}

/** `text` with the [start, end) `ranges` wrapped in <mark>, built as text nodes (file names are data). */
function markedText(text, ranges){
	const fragment = document.createDocumentFragment();
	let position = 0;
	for(const [start, end] of ranges){
		if(start < position || end <= start || end > text.length){
			continue;
		}
		if(start > position){
			fragment.append(text.slice(position, start));
		}
		fragment.append(element("mark", null, text.slice(start, end)));
		position = end;
	}
	if(position < text.length){
		fragment.append(text.slice(position));
	}
	return fragment;
}

function isEditableTarget(target){
	return !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function injectStyles(){
	if(document.getElementById(STYLE_ID)){
		return;
	}
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		.pv-isearch{
			--pv-isearch-bg: rgba(18, 20, 24, 0.88);
			--pv-isearch-border: rgba(255, 255, 255, 0.22);
			--pv-isearch-muted: rgba(236, 240, 245, 0.68);
			--pv-isearch-accent: #2f7de1;
			--pv-isearch-mark: #ffd23f;
			position: absolute; top: var(--pv-isearch-top, ${EDGE}px); left: var(--pv-isearch-left, 56px); z-index: 10001;
			width: var(--pv-isearch-width, 300px);
			color: #eef1f5; text-align: left;
			font: 13px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
		}
		.pv-isearch[hidden], .pv-isearch [hidden]{ display: none !important; }
		html.project-preview .pv-isearch{ display: none !important; }
		.pv-isearch button{ font: inherit; color: inherit; margin: 0; cursor: pointer; }
		.pv-isearch button:focus-visible{ outline: 2px solid #5aa9ff; outline-offset: 1px; }
		.pv-isearch-box{
			background: var(--pv-isearch-bg); border: 1px solid var(--pv-isearch-border);
			border-radius: 8px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
			-webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
		}
		.pv-isearch-toggle{
			display: none; align-items: center; justify-content: center;
			width: 40px; height: 40px; padding: 0;
		}
		.pv-isearch-toggle:hover{ background: rgba(40, 44, 52, 0.95); }
		.pv-isearch-toggle[aria-expanded="true"]{ border-color: #5aa9ff; }
		.pv-isearch-combo{ position: relative; }
		.pv-isearch-field{
			display: flex; align-items: center; gap: 6px; box-sizing: border-box;
			height: 34px; padding: 0 4px 0 9px;
		}
		.pv-isearch-field:focus-within{
			border-color: #5aa9ff;
			box-shadow: 0 0 0 2px rgba(90, 169, 255, 0.35), 0 2px 10px rgba(0, 0, 0, 0.45);
		}
		.pv-isearch-icon{ flex: none; opacity: 0.8; }
		.pv-isearch-input{
			flex: 1; min-width: 0; height: 100%; margin: 0; padding: 0;
			border: 0; outline: none; background: transparent; color: inherit; font: inherit;
		}
		.pv-isearch-input::placeholder{ color: var(--pv-isearch-muted); opacity: 1; }
		.pv-isearch-kbd{
			flex: none; margin-right: 4px; padding: 0 5px; border-radius: 4px;
			border: 1px solid rgba(255, 255, 255, 0.3); color: var(--pv-isearch-muted);
			font: 11px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		}
		.pv-isearch-clear{
			flex: none; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 5px;
			background: transparent; font-size: 18px; line-height: 26px;
		}
		.pv-isearch-clear:hover{ background: rgba(255, 255, 255, 0.14); }
		.pv-isearch-popup{
			position: absolute; top: calc(100% + 4px); left: 0;
			width: var(--pv-isearch-popup-width, 100%); max-width: calc(100vw - 20px); overflow: hidden;
		}
		.pv-isearch-list{
			position: relative; list-style: none; margin: 0; padding: 4px; max-height: min(60vh, 420px); overflow-y: auto;
		}
		.pv-isearch-option{
			display: flex; flex-direction: column; gap: 1px;
			padding: 6px 9px; border-radius: 6px; cursor: pointer;
		}
		.pv-isearch-option:hover{ background: rgba(255, 255, 255, 0.08); }
		.pv-isearch-option[aria-selected="true"]{ background: var(--pv-isearch-accent); color: #fff; }
		.pv-isearch-name{
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
			font-variant-numeric: tabular-nums;
		}
		.pv-isearch-name mark{
			padding: 0; border-radius: 2px; font-weight: 700;
			background: rgba(255, 210, 63, 0.24); color: var(--pv-isearch-mark);
		}
		.pv-isearch-option[aria-selected="true"] mark{ background: rgba(255, 255, 255, 0.24); color: #fff; }
		.pv-isearch-meta{
			font-size: 11.5px; color: var(--pv-isearch-muted);
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.pv-isearch-option[aria-selected="true"] .pv-isearch-meta{ color: rgba(255, 255, 255, 0.85); }
		.pv-isearch-status{ padding: 6px 12px 7px; font-size: 12px; color: var(--pv-isearch-muted); }
		.pv-isearch-list:not([hidden]) + .pv-isearch-status{ border-top: 1px solid rgba(255, 255, 255, 0.1); }
		.pv-isearch-found{
			margin-top: 4px; padding: 5px 4px 4px 10px; border-color: rgba(255, 210, 63, 0.6);
		}
		.pv-isearch-found-name{
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600;
			font-variant-numeric: tabular-nums;
		}
		.pv-isearch-found-line{ display: flex; align-items: center; gap: 8px; margin-top: 3px; }
		.pv-isearch-found-meta{
			flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
			font-size: 11.5px; color: var(--pv-isearch-muted);
		}
		.pv-isearch-open{
			flex: none; min-height: 30px; padding: 0 10px; border-radius: 6px;
			border: 1px solid var(--pv-isearch-accent); background: var(--pv-isearch-accent); color: #fff;
			white-space: nowrap;
		}
		.pv-isearch-open:hover{ background: #4a90ea; }
		.pv-isearch--map-over .pv-isearch-found{ display: none !important; }
		.pv-isearch-sr{
			position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
			clip: rect(0 0 0 0); white-space: nowrap; border: 0;
		}
		.pv-isearch--compact{ width: auto; }
		.pv-isearch--compact .pv-isearch-toggle{ display: inline-flex; }
		.pv-isearch--compact .pv-isearch-panel{
			display: none; position: absolute; top: calc(100% + 6px); left: 0;
			width: var(--pv-isearch-panel-width, 300px);
		}
		.pv-isearch--compact.pv-isearch--expanded .pv-isearch-panel{ display: block; }
		.pv-isearch--compact .pv-isearch-popup{ width: 100%; }
		.pv-isearch--compact .pv-isearch-kbd{ display: none; }
		@media (pointer: coarse){
			.pv-isearch-toggle{ width: 44px; height: 44px; }
			.pv-isearch-field{ height: 44px; }
			.pv-isearch-clear{ width: 36px; height: 36px; }
			.pv-isearch-option{ padding: 9px 10px; }
			.pv-isearch-open{ min-height: 38px; }
			.pv-isearch-kbd{ display: none; }
		}
	`;
	document.head.append(style);
}

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

class ImageSearch{

	constructor(viewer){
		this.viewer = viewer;
		this.id = `pv-isearch-${++instanceCount}`;
		this.entries = [];      // the index, see buildIndex()
		this.results = [];      // matches shown in the list
		this.active = -1;       // index into `results` of the highlighted candidate
		this.found = null;      // entry last flown to, shown in the result line
		this.compact = false;   // collapsed into a button (narrow screen or little room)
		this.expanded = false;  // collapsed, but opened
		this.disposed = false;
		this._setCount = 0;     // image sets in `entries`
		this._short = false;    // narrow field: short placeholder and button label
		this._timer = null;     // debounce of the search while typing
		this._flashOff = null;  // ends the current flash and restores the marker
		this._flight = null;    // the camera move to a found image, see _moveTo()
		this._cleanup = [];     // undo listeners and observers (dispose)
		this._scene = null;
		this._sceneCleanup = [];
		const media = query => typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
		this._reducedMotion = media("(prefers-reduced-motion: reduce)");
		this._coarsePointer = media("(pointer: coarse)");

		injectStyles();
		this._build();
		this._bindScene(viewer.scene);
		this._listen(viewer, "scene_changed", event => this._bindScene(event.scene));
		this._watchLayout();
	}

	/**
	 * The best matches for `text` (as listed by the control).
	 * @returns {{total: number, results: Array<{name, path, setName, index, count, image, set}>}}
	 */
	search(text, limit = MAX_RESULTS){
		const {total, results} = findImages(this.entries, text, limit);
		return {total, results: results.map(({entry}) => ({
			name: entry.name,
			path: entry.path,
			setName: entry.source.name,
			index: entry.index,
			count: entry.source.images.length,
			image: entry.image,
			set: entry.source.set,
		}))};
	}

	/** Shows the image whose file name best matches `text`, as choosing it in the list does. */
	goTo(text){
		const {results} = findImages(this.entries, text, 1);
		if(results.length === 0){
			return false;
		}
		this._choose(results[0].entry);
		return true;
	}

	dispose(){
		if(this.disposed){
			return;
		}
		this.disposed = true;
		clearTimeout(this._timer);
		this._stopFlight();
		this._clearFlash();
		this._unbindScene();
		this._cleanup.forEach(undo => undo());
		this._cleanup = [];
		this.root.remove();
		instances.delete(this.viewer);
	}

	// ----- scene ----------------------------------------------------------------

	_listen(target, type, listener, options){
		if(typeof target.removeEventListener !== "function"){
			return;
		}
		target.addEventListener(type, listener, options);
		this._cleanup.push(() => target.removeEventListener(type, listener, options));
	}

	_bindScene(scene){
		this._unbindScene();
		this._scene = scene;
		if(scene){
			const reindex = () => this._reindex();
			const types = ["360_images_added", "360_images_removed", "oriented_images_added", "oriented_images_removed"];
			for(const type of types){
				scene.addEventListener(type, reindex);
			}
			this._sceneCleanup.push(() => types.forEach(type => scene.removeEventListener(type, reindex)));
		}
		this._reindex();
	}

	_unbindScene(){
		this._sceneCleanup.forEach(undo => undo());
		this._sceneCleanup = [];
		this._scene = null;
	}

	_reindex(){
		const sources = this._scene ? collectSources(this._scene) : [];
		this._setCount = sources.length;
		this.entries = buildIndex(sources);
		this.root.hidden = this.entries.length === 0;
		if(this.found && !this.entries.some(entry => entry.image === this.found.image)){
			this._setFound(null);
		}
		if(!this.popup.hidden){
			this._runSearch();
		}
		this._layout();
	}

	/** The Images360 set with an open panorama, if any. */
	_focusedSet(){
		const sets = this.viewer.scene.images360 || [];
		return sets.find(set => set.focusedImage) || null;
	}

	/** Potree's controls of an open oriented photo, if one is open. */
	_photoControls(){
		const controls = this.viewer.controls;
		return controls && typeof controls.hasSomethingCaptured === "function" && controls.hasSomethingCaptured() ? controls : null;
	}

	/** True while a panorama or an oriented photo is open. */
	_imageOpen(){
		return Boolean(this._focusedSet() || this._photoControls());
	}

	// ----- DOM ------------------------------------------------------------------

	_build(){
		const id = this.id;
		const root = element("div", "pv-isearch");
		root.setAttribute("role", "search");
		root.hidden = true;

		const toggle = element("button", "pv-isearch-toggle pv-isearch-box");
		toggle.type = "button";
		toggle.title = "Find image by file name (/)";
		toggle.setAttribute("aria-label", "Find image by file name");
		toggle.setAttribute("aria-expanded", "false");
		toggle.setAttribute("aria-controls", `${id}-panel`);
		toggle.append(magnifierIcon());

		const panel = element("div", "pv-isearch-panel");
		panel.id = `${id}-panel`;

		const combo = element("div", "pv-isearch-combo");
		const field = element("div", "pv-isearch-field pv-isearch-box");
		const input = element("input", "pv-isearch-input");
		input.type = "text";
		input.placeholder = "Find image by file name…";
		input.autocomplete = "off";
		input.spellcheck = false;
		input.setAttribute("autocapitalize", "off");
		input.setAttribute("enterkeyhint", "search");
		input.setAttribute("role", "combobox");
		input.setAttribute("aria-label", "Find image by file name");
		input.setAttribute("aria-autocomplete", "list");
		input.setAttribute("aria-expanded", "false");
		input.setAttribute("aria-controls", `${id}-list`);
		const kbd = element("kbd", "pv-isearch-kbd", "/");
		kbd.title = "Press / to search";
		kbd.setAttribute("aria-hidden", "true");
		const clear = element("button", "pv-isearch-clear", "×");
		clear.type = "button";
		clear.title = "Clear";
		clear.setAttribute("aria-label", "Clear search");
		clear.hidden = true;
		field.append(magnifierIcon(), input, kbd, clear);

		const popup = element("div", "pv-isearch-popup pv-isearch-box");
		popup.hidden = true;
		const list = element("ul", "pv-isearch-list");
		list.id = `${id}-list`;
		list.setAttribute("role", "listbox");
		list.setAttribute("aria-label", "Matching images");
		const status = element("div", "pv-isearch-status");
		popup.append(list, status);
		combo.append(field, popup);

		// The result line: the found image, its place in the set and "Open panorama".
		const foundRow = element("div", "pv-isearch-found pv-isearch-box");
		foundRow.hidden = true;
		const foundName = element("div", "pv-isearch-found-name");
		const foundLine = element("div", "pv-isearch-found-line");
		const foundMeta = element("span", "pv-isearch-found-meta");
		const open = element("button", "pv-isearch-open", "Open panorama");
		open.type = "button";
		foundLine.append(foundMeta, open);
		foundRow.append(foundName, foundLine);

		const announcer = element("div", "pv-isearch-sr");
		announcer.setAttribute("role", "status");
		announcer.setAttribute("aria-live", "polite");

		panel.append(combo, foundRow);
		root.append(toggle, panel, announcer);
		this.viewer.renderArea.append(root);

		Object.assign(this, {root, toggle, panel, field, input, kbd, clear, popup, list, status, foundRow,
			foundName, foundMeta, open, announcer});

		input.addEventListener("input", () => this._onInput());
		input.addEventListener("keydown", event => this._onKeyDown(event));
		input.addEventListener("focus", () => {
			if(this.input.value.trim() && !this.found){
				this._runSearch();
			}
		});
		// Keep the focus in the field while a candidate is clicked or tapped.
		popup.addEventListener("mousedown", event => event.preventDefault());
		list.addEventListener("click", event => {
			const option = event.target.closest(".pv-isearch-option");
			if(option){
				this._choose(this.results[Number(option.dataset.index)].entry);
			}
		});
		list.addEventListener("mousemove", event => {
			const option = event.target.closest(".pv-isearch-option");
			if(option && Number(option.dataset.index) !== this.active){
				this._setActive(Number(option.dataset.index), false);
			}
		});
		toggle.addEventListener("click", () => {
			if(this.expanded){
				this._collapse(false);
			}else{
				this.focusInput();
			}
		});
		clear.addEventListener("click", () => {
			this._reset();
			this.input.focus();
		});
		open.addEventListener("click", () => {
			if(this.found){
				this._open(this.found);
			}
		});
		root.addEventListener("focusout", event => {
			if(!root.contains(event.relatedTarget)){
				this._closeList();
			}
		});

		// Clicks elsewhere (e.g. on the 3D view, which does not take the focus)
		// close the list and the expanded control.
		this._listen(document, "pointerdown", event => {
			if(root.contains(event.target)){
				return;
			}
			this._closeList();
			if(this.compact && this.expanded){
				this._collapse(false);
			}
		}, true);

		this._listen(window, "keydown", event => {
			if(event.key !== "/" || event.defaultPrevented || this.root.hidden || isEditableTarget(event.target)){
				return;
			}
			// Ctrl/Cmd shortcuts belong to the browser; Ctrl+Alt is AltGr.
			if(event.metaKey || (event.ctrlKey && !event.altKey)){
				return;
			}
			event.preventDefault();
			this.focusInput();
		});
	}

	/** Shows the field (expanding the collapsed control) and puts the cursor in it. */
	focusInput(){
		if(this.compact && !this.expanded){
			this.expanded = true;
			this._syncExpanded();
		}
		this.input.focus();
		this.input.select();
	}

	_collapse(focusToggle){
		this._closeList();
		this.expanded = false;
		this._syncExpanded();
		if(focusToggle){
			this.toggle.focus();
		}
	}

	_syncExpanded(){
		const expanded = this.compact && this.expanded;
		this.root.classList.toggle("pv-isearch--expanded", expanded);
		this.toggle.setAttribute("aria-expanded", String(expanded));
		this._avoidMap(); // the field has just been shown or hidden
	}

	// ----- layout ---------------------------------------------------------------

	_watchLayout(){
		const layout = () => this._layout();
		const area = this.viewer.renderArea;
		if(typeof ResizeObserver === "function"){
			// The render area changes width with the window and, frame by frame,
			// while the sidebar slides in or out.
			const observer = new ResizeObserver(layout);
			observer.observe(area);
			this._cleanup.push(() => observer.disconnect());
		}
		this._listen(window, "resize", layout);
		if(typeof MutationObserver === "function"){
			// The description text and the quick buttons arrive with the GUI.
			const observer = new MutationObserver(layout);
			observer.observe(area, {childList: true});
			for(const id of ["potree_description", "potree_quick_buttons"]){
				const target = document.getElementById(id);
				if(target){
					observer.observe(target, {childList: true, subtree: true, characterData: true});
				}
			}
			// Potree's map window: shown, hidden and dragged through its inline style.
			const map = document.getElementById("potree_map");
			if(map){
				observer.observe(map, {attributes: true, attributeFilter: ["style"]});
			}
			this._cleanup.push(() => observer.disconnect());
		}
		if(typeof this.viewer.onGUILoaded === "function"){
			this.viewer.onGUILoaded(layout);
		}
		layout();
	}

	/**
	 * Places the field right of Potree's quick buttons (a column at the top
	 * left of the view that moves with the sidebar — and so does this control:
	 * both live in the render area), as wide as the room before the next
	 * element on that row: the page's back link or Potree's description text.
	 * Too little room, or a narrow screen, collapses it into a button that
	 * joins the bottom of the quick-button column, where nothing else competes.
	 * Potree's map window, opened on purpose, keeps its header and zoom
	 * buttons: the result line steps aside while the map overlaps it.
	 */
	_layout(){
		if(this.disposed){
			return;
		}
		const area = this.viewer.renderArea;
		const box = area.getBoundingClientRect();
		if(box.width === 0 || box.height === 0){
			return;
		}

		let column = null;
		for(const button of area.querySelectorAll("#potree_quick_buttons > *")){
			const rect = button.getBoundingClientRect();
			if(rect.width > 0 && rect.height > 0){
				column = {
					left: Math.min(column ? column.left : Infinity, rect.left - box.left),
					right: Math.max(column ? column.right : -Infinity, rect.right - box.left),
					bottom: Math.max(column ? column.bottom : -Infinity, rect.bottom - box.top),
				};
			}
		}

		const left = column ? Math.round(column.right) + GAP : EDGE;
		const rowTop = box.top + EDGE;
		const rowBottom = rowTop + ROW_HEIGHT;
		let right = box.width - EDGE;
		const neighbours = [document.querySelector(".project-backlink"), document.getElementById("potree_description")];
		for(const neighbour of neighbours){
			if(!neighbour || !neighbour.textContent.trim()){
				continue;
			}
			const rect = neighbour.getBoundingClientRect();
			if(rect.width > 0 && rect.height > 0 && rect.top < rowBottom && rect.bottom > rowTop
				&& rect.right > box.left + left){
				right = Math.min(right, Math.round(rect.left - box.left) - GAP);
			}
		}

		const room = right - left;
		const compact = window.innerWidth <= NARROW_SCREEN_MAX_WIDTH || room < MIN_FIELD_WIDTH;
		const place = compact && column
			? {left: Math.round(column.left), top: Math.round(column.bottom) + GAP}
			: {left, top: EDGE};
		// Below the row of top controls the candidate list may grow wider than the field.
		const roomBelow = box.width - place.left - EDGE;
		const fieldWidth = Math.max(0, Math.min(MAX_FIELD_WIDTH, room));

		const style = this.root.style;
		style.setProperty("--pv-isearch-left", `${place.left}px`);
		style.setProperty("--pv-isearch-top", `${place.top}px`);
		style.setProperty("--pv-isearch-width", `${fieldWidth}px`);
		style.setProperty("--pv-isearch-popup-width", `${Math.max(fieldWidth, Math.min(MAX_POPUP_WIDTH, roomBelow))}px`);
		style.setProperty("--pv-isearch-panel-width", `${Math.max(0, Math.min(MAX_POPUP_WIDTH, roomBelow))}px`);
		// A phone with the sidebar open leaves a sliver of 3D view: step aside.
		style.visibility = compact && roomBelow < MIN_FIELD_WIDTH ? "hidden" : "";
		// A narrow field gets the short wording.
		this._short = !compact && fieldWidth < SHORT_PLACEHOLDER_WIDTH;
		this.input.placeholder = this._short ? "Find image…" : "Find image by file name…";
		this._labelOpenButton();

		if(compact !== this.compact){
			this.compact = compact;
			this.root.classList.toggle("pv-isearch--compact", compact);
			if(!compact){
				this.expanded = false;
			}
			this._syncExpanded();
		}

		this._avoidMap();
	}

	/** Hides the result line while Potree's map window is shown where it goes (below the field). */
	_avoidMap(){
		const map = document.getElementById("potree_map");
		let covered = false;
		if(map && map.offsetParent !== null){
			const mapBox = map.getBoundingClientRect();
			const field = this.field.getBoundingClientRect();
			covered = mapBox.width > 0 && mapBox.height > 0 && field.width > 0
				&& mapBox.left < field.right && mapBox.right > field.left
				&& mapBox.top < field.bottom + FOUND_ROW_EXTENT && mapBox.bottom > field.bottom;
		}
		this.root.classList.toggle("pv-isearch--map-over", covered);
	}

	// ----- typing and the candidate list ---------------------------------------

	_onInput(){
		const hasText = this.input.value.length > 0;
		this.clear.hidden = !hasText;
		this.kbd.hidden = hasText;
		if(this.found){
			this._setFound(null);
		}
		clearTimeout(this._timer);
		if(!this.input.value.trim()){
			this._closeList();
			return;
		}
		this._timer = setTimeout(() => this._runSearch(), DEBOUNCE_MS);
	}

	_runSearch(){
		clearTimeout(this._timer);
		this._timer = null;
		const text = this.input.value;
		if(!text.trim()){
			this._closeList();
			return;
		}

		const {total, usePath, results} = findImages(this.entries, text);
		this.results = results;
		this.list.textContent = "";
		results.forEach((match, i) => {
			const {entry} = match;
			const shown = usePath ? entry.path : entry.name;
			const option = element("li", "pv-isearch-option");
			option.id = `${this.id}-option-${i}`;
			option.dataset.index = String(i);
			option.setAttribute("role", "option");
			option.title = entry.path;
			const name = element("span", "pv-isearch-name");
			name.append(entry.markable ? markedText(shown, match.ranges) : shown);
			const meta = element("span", "pv-isearch-meta", this._describe(entry, true));
			option.append(name, meta);
			this.list.append(option);
		});
		this.list.hidden = results.length === 0;

		let summary;
		if(total === 0){
			summary = `No image matches “${text.trim()}”`;
		}else if(total > results.length){
			summary = `${results.length} of ${total.toLocaleString("en")} matches`;
		}else{
			summary = total === 1 ? "1 match" : `${total} matches`;
		}
		this.status.textContent = summary;
		this.announcer.textContent = summary;

		this.popup.hidden = false;
		this.foundRow.hidden = true;
		this.input.setAttribute("aria-expanded", String(results.length > 0));
		this._setActive(results.length > 0 ? 0 : -1, true);
	}

	_setActive(index, scroll){
		this.active = index;
		[...this.list.children].forEach((option, i) => option.setAttribute("aria-selected", String(i === index)));
		const option = index >= 0 ? this.list.children[index] : null;
		if(option){
			this.input.setAttribute("aria-activedescendant", option.id);
			if(scroll){
				// Scroll the list only (scrollIntoView could also shift the page's overflow-hidden containers).
				const list = this.list;
				if(option.offsetTop < list.scrollTop){
					list.scrollTop = option.offsetTop;
				}else if(option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight){
					list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
				}
			}
		}else{
			this.input.removeAttribute("aria-activedescendant");
		}
	}

	_closeList(){
		clearTimeout(this._timer);
		this._timer = null;
		this.popup.hidden = true;
		this.input.setAttribute("aria-expanded", "false");
		this.input.removeAttribute("aria-activedescendant");
		this.foundRow.hidden = !this.found;
	}

	_listOpen(){
		return !this.popup.hidden;
	}

	_onKeyDown(event){
		if(event.isComposing){
			return; // the keys belong to the input method
		}
		const count = this.results.length;
		switch(event.key){
			case "ArrowDown":
			case "ArrowUp": {
				event.preventDefault();
				if(!this._listOpen() || this._timer){
					this._runSearch();
					return;
				}
				if(count > 0){
					const step = event.key === "ArrowDown" ? 1 : -1;
					this._setActive((this.active + step + count) % count, true);
				}
				return;
			}
			case "Enter": {
				event.preventDefault();
				// The list is not up to date: typed faster than the debounce, or closed with Esc.
				if(this._timer || (!this._listOpen() && !this.found && this.input.value.trim())){
					this._runSearch();
				}
				if(this._listOpen()){
					if(this.results.length > 0){
						this._choose(this.results[Math.max(0, this.active)].entry);
					}
				}else if(this.found){
					this._open(this.found);
				}
				return;
			}
			case "Escape": {
				event.preventDefault();
				event.stopPropagation();
				if(this._listOpen()){
					this._closeList();
				}else if(this.input.value || this.found){
					this._reset();
				}else if(this.compact){
					this._collapse(true);
				}else{
					this.input.blur();
				}
				return;
			}
			default:
				return;
		}
	}

	_reset(){
		this.input.value = "";
		this.status.textContent = "";
		this.clear.hidden = true;
		this.kbd.hidden = false;
		this.results = [];
		this.list.textContent = "";
		this._setFound(null);
		this._closeList();
	}

	/** "360° images · #1234 / 6173" (with the set name) or "#1234 / 6173". */
	_describe(entry, withSet){
		const position = `#${entry.index + 1} / ${entry.source.images.length}`;
		return withSet ? `${entry.source.name} · ${position}` : position;
	}

	_setFound(entry){
		this.found = entry;
		if(entry){
			this.foundName.textContent = entry.name;
			this.foundName.title = entry.path;
			// The set name only matters when there are several sets.
			this.foundMeta.textContent = this._describe(entry, this._setCount > 1);
			this.foundMeta.title = this._describe(entry, true);
			this.open.hidden = !this._canOpen(entry);
			this._labelOpenButton();
		}else{
			this._clearFlash();
		}
		this.foundRow.hidden = !entry || this._listOpen();
	}

	// ----- going to an image ----------------------------------------------------

	_labelOpenButton(){
		const label = this.found && this.found.source.kind !== "360" ? "Open photo" : "Open panorama";
		this.open.textContent = this._short ? "Open" : label;
		this.open.setAttribute("aria-label", label);
		this.open.title = `${label} (Enter)`;
	}

	_choose(entry){
		this._closeList();
		this.input.value = entry.name;
		this.clear.hidden = false;
		this.kbd.hidden = true;

		const {source, image} = entry;
		if(source.set.visible === false){
			source.set.visible = true;
		}

		if(this._focusedSet() && source.kind === "360"){
			// Stay in the 360° view: switch to the found panorama.
			this._stopFlight();
			this._setFound(null);
			source.set.focus(image);
			this.announcer.textContent = `Showing ${entry.name}`;
			this._leaveToView();
			return;
		}
		this._closeImage();

		this._setFound(entry);
		this._flyTo(entry);
		this._flash(entry);
		this.announcer.textContent = `Found ${entry.name}, ${this._describe(entry, true)}`;
		if(this._coarsePointer && this._coarsePointer.matches){
			this.input.blur(); // put the on-screen keyboard away so the view is seen
		}
	}

	/** Leaves an open panorama or oriented photo. */
	_closeImage(){
		const focused = this._focusedSet();
		if(focused){
			focused.unfocus();
		}
		const photo = this._photoControls();
		if(photo){
			photo.release();
		}
	}

	_canOpen(entry){
		if(entry.source.kind === "360"){
			return typeof entry.source.set.focus === "function";
		}
		// OrientedImages has no public "open"; Potree's debug hook belongs to the set loaded last.
		const debug = window.Potree && Potree.debug;
		const sets = this.viewer.scene.orientedImages || [];
		return Boolean(debug && typeof debug.moveToImage === "function" && sets.length === 1);
	}

	_open(entry){
		if(!this._canOpen(entry)){
			return;
		}
		// The flight to the image must not carry the camera away from it again.
		this._stopFlight();
		this._setFound(null);
		const {source, image} = entry;
		if(source.set.visible === false){
			source.set.visible = true;
		}
		if(source.kind === "360"){
			const photo = this._photoControls();
			if(photo){
				photo.release();
			}
			source.set.focus(image); // takes over from another set's open panorama itself
		}else{
			this._closeImage();
			Potree.debug.moveToImage(image);
		}
		this._leaveToView();
	}

	/**
	 * Hands the keyboard back to the view once an image is open, so that its
	 * shortcuts ([ ] l) work at once; "/" comes back here.
	 */
	_leaveToView(){
		if(this.root.contains(document.activeElement)){
			document.activeElement.blur();
		}
		if(this.compact){
			this._collapse(false);
		}
	}

	/**
	 * Flies to a view of the image (see approachPositions): down the street
	 * rather than across the buildings beside it, from the side the user looks
	 * from, unless something stands in the way — the first view with a clear
	 * line of sight onto the image in the points loaded now. Once there, the
	 * view is checked again with the finer points (_verifyView).
	 */
	_flyTo(entry){
		const target = entry.source.positionOf(entry.image);
		const positions = approachPositions(entry, target, this.viewer.scene.view);
		const {index} = bestView(this.viewer.scene.pointclouds, positions, target);
		this._moveTo({entry, target, positions, index}, FLIGHT_MS, flight => this._verifyView(flight));
	}

	/**
	 * Moves the camera to `flight.positions[flight.index]`, looking at
	 * `flight.target`, over `ms` (at once with reduced motion), in place of an
	 * earlier move. It is stopped by _stopFlight() — and by itself as soon as
	 * an image is opened meanwhile (a click on a panorama sphere or a photo, the
	 * 360° keys): opening one starts a shorter camera move of its own, which
	 * this one would otherwise outlast and undo. `onArrive(flight)` runs at the end.
	 */
	_moveTo(flight, ms, onArrive){
		this._stopFlight();
		this._flight = flight;
		flight.tween = null;
		flight.stops = [];
		const instant = ms === 0 || Boolean(this._reducedMotion && this._reducedMotion.matches);
		const arrive = () => {
			if(this._flight === flight){
				flight.tween = null;
				if(onArrive){
					onArrive(flight);
				}
			}
		};
		// View.setView keeps no handle to its animation: find it among TWEEN's.
		const tweens = window.TWEEN && typeof window.TWEEN.getAll === "function" ? window.TWEEN : null;
		const before = tweens ? new Set(tweens.getAll()) : null;
		this.viewer.scene.view.setView(flight.positions[flight.index], flight.target, instant ? 0 : ms, arrive);
		if(instant){
			arrive(); // setView calls back only at the end of an animation
			return;
		}
		flight.tween = before ? tweens.getAll().find(tween => !before.has(tween)) || null : null;
		this._everyFrame(flight, () => {
			if(this._imageOpen()){
				this._stopFlight();
			}
		});
	}

	/** Runs `onFrame` on every frame of the viewer until the flight is stopped. */
	_everyFrame(flight, onFrame){
		const viewer = this.viewer;
		const listener = () => {
			try{
				onFrame();
			}catch(err){
				// An exception in an "update" listener would stop Potree's render loop.
				console.warn("[image search] camera move stopped after an error", err);
				this._stopFlight();
			}
		};
		viewer.addEventListener("update", listener);
		flight.stops.push(() => viewer.removeEventListener("update", listener));
	}

	/** Stops the camera move to a found image (where the camera is) and the check that follows it. */
	_stopFlight(){
		const flight = this._flight;
		if(!flight){
			return;
		}
		this._flight = null;
		if(flight.tween){
			flight.tween.stop(); // tween.js 0.15: also removes it from TWEEN's list
		}
		flight.stops.forEach(stop => stop());
	}

	/**
	 * Before the flight, only the coarse levels of a distant place are loaded.
	 * Once the point cloud around the new view has loaded, its line of sight is
	 * tested again; when it is blocked, the other views are tested, one per
	 * frame (each test takes some milliseconds), and the camera moves on to the
	 * clearest one (the earliest of equals; a free one ends the search). Given
	 * up as soon as the user moves the camera, an image is opened or the search
	 * moves on.
	 */
	_verifyView(flight){
		const view = this.viewer.scene.view;
		const arrived = {position: view.position.clone(), yaw: view.yaw, pitch: view.pitch};
		const startedAt = performance.now();
		let quietFrames = 0;
		let others = null; // views still to test once the current one is found blocked
		let best = null;
		this._everyFrame(flight, () => {
			const moved = view.position.distanceTo(arrived.position) > 0.01
				|| Math.abs(view.yaw - arrived.yaw) > 1e-4 || Math.abs(view.pitch - arrived.pitch) > 1e-4;
			if(moved || this.found !== flight.entry || this._imageOpen()){
				this._stopFlight();
				return;
			}
			const pointclouds = this.viewer.scene.pointclouds;
			if(!others){
				quietFrames = window.Potree && Potree.numNodesLoading > 0 ? 0 : quietFrames + 1;
				if(quietFrames < VERIFY.quietFrames && performance.now() - startedAt < VERIFY.maxWaitMs){
					return;
				}
				const sight = lineOfSight(pointclouds, flight.positions[flight.index], flight.target);
				if(sight.clear){
					this._stopFlight();
					return;
				}
				best = {index: flight.index, sight};
				others = flight.positions.map((position, index) => index).filter(index => index !== flight.index);
				return;
			}
			const index = others.shift();
			const sight = lineOfSight(pointclouds, flight.positions[index], flight.target);
			if(sight.score < best.sight.score){
				best = {index, sight};
			}
			if(best.sight.score === 0 || others.length === 0){
				this._stopFlight();
				if(best.index !== flight.index){
					this._moveTo({...flight, index: best.index}, VERIFY.moveMs, null);
				}
			}
		});
	}

	_flash(entry){
		this._clearFlash();
		const flash = createFlash(this.viewer, entry);
		if(!flash){
			return;
		}
		const viewer = this.viewer;
		const startedAt = performance.now();
		const onUpdate = () => {
			// Opening the image (or another one) ends the flash.
			if(this._imageOpen()){
				this._clearFlash();
				return;
			}
			try{
				if(!flash.update(performance.now() - startedAt, Boolean(this._reducedMotion && this._reducedMotion.matches))){
					this._clearFlash();
				}
			}catch(err){
				// An exception in an "update" listener would stop Potree's render loop.
				console.warn("[image search] flash stopped after an error", err);
				this._clearFlash();
			}
		};
		viewer.addEventListener("update", onUpdate);
		this._flashOff = () => {
			viewer.removeEventListener("update", onUpdate);
			flash.dispose();
		};
		onUpdate();
	}

	/** Ends the current flash, if any, and restores the image's marker. */
	_clearFlash(){
		if(this._flashOff){
			const off = this._flashOff;
			this._flashOff = null;
			off();
		}
	}

}
