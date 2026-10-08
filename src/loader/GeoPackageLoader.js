import * as THREE from "../../libs/three.js/build/three.module.js";
import {Line2} from "../../libs/three.js/lines/Line2.js";
import {LineGeometry} from "../../libs/three.js/lines/LineGeometry.js";
import {LineMaterial} from "../../libs/three.js/lines/LineMaterial.js";
import {Utils} from "../utils.js";

const defaultColors = {
	"chambres":   		[1.0, 1.0, 0.0],
	"chambres2":   		[0.0, 1.0, 0.0],
	"grilles":   	 	[1.0, 0.0, 1.0],
	"hydrants":  		[0.0, 1.0, 1.0],
	"top_edge":     	[0.0, 1.0, 1.0],
	"bottom_edge":     	[0.0, 1.0, 1.0],
	"Pylône":   		[0.5, 0.5, 0.5],
	"wall_lines":   	[0.0, 1.0, 0.0],
	"Conducteur": 		[1.0, 0.0, 1.0],
	"road_marking":    	[1.0, 0.0, 1.0],
	"Câble_de_garde": 	[0.0, 1.0, 1.0],
	"rectangular_sign": [0.0, 1.0, 1.0],
	"low_cfd_objects": [1.0, 0.0, 0.0],
	"circular_sign": [0.9, 0.6, 0.1],
	// SAM3 zero-shot ground classes localised on the Vevey LiDAR DEM
	// (nearai-seg/orbis_localize). Same hues as the 2D quicklook map so the
	// two can be read side by side.
	"road_surface":      [0.31, 0.51, 0.84],
	"sidewalk":          [0.83, 0.44, 0.83],
	"road_edge":         [0.20, 0.80, 0.33],
	"line_road_marking": [1.00, 0.79, 0.24],
	"bicycle_marking":   [1.00, 0.30, 0.30],
	// Marking boundaries, split by the paint colour measured off the panorama.
	// Yellow is the one that matters: a Swiss cycle lane has a yellow line on at
	// least one side, so it is drawn in its own colour and the rest recede.
	"boundary_yellow":   [1.00, 0.76, 0.05],
	"boundary_white":    [0.85, 0.88, 0.94],
	"boundary_other":    [0.45, 0.50, 0.58],
	"kerb":              [0.20, 0.72, 0.40],
	"line_road_marking_yellow": [1.00, 0.76, 0.05],
	"line_road_marking_white":  [0.85, 0.88, 0.94],
	"bicycle_marking_yellow":   [1.00, 0.25, 0.25],
	// Candidate bicycle lanes. Split into three layers because this loader
	// colours by layer name, which is the only way the confidence ranking
	// survives into the 3D scene.
	// The finetuned SAM3 model's own output: it predicts the lane SURFACE
	// directly, so there is no confidence ranking to split into layers and no
	// pair/sweep inference behind it. Drawn cyan so it reads apart from v50's
	// green/amber/grey confidence tiers when both files are ticked together.
	"bicycle_lane_ft":   [0.10, 0.85, 0.95],
	// Round 6: the first finetune trained without NaN steps (focal-loss gamma=0
	// and bf16 loss-scale fixes). Magenta, so it reads apart from round 3's cyan
	// and from v50 when all three are ticked together.
	"bicycle_lane_ft_r6": [0.95, 0.25, 0.85],
	"bike_lane_high":    [0.15, 0.95, 0.35],
	"bike_lane_medium":  [1.00, 0.85, 0.15],
	"bike_lane_low":     [0.55, 0.60, 0.68],
	"bike_lane_axis":    [1.00, 1.00, 1.00],
	// Closed polygons the repaired network bounds. Drawn cool and dim: they are
	// the by-product that shows the topology closed, not the deliverable.
	"face":              [0.35, 0.68, 0.85],
	"graph_edge":        [0.55, 0.60, 0.70],
	"pair_rail":         [0.10, 1.00, 0.55],
	"graph_node":        [0.90, 0.35, 0.35],
	"bike_lane_candidate": [0.15, 0.95, 0.35],
	// What the road-relative filter rejected as not bounding a lane. Drawn in
	// warning reds so a wrong rejection is visible rather than simply absent:
	// the point of shipping these is that they can be argued with.
	// Second detection pass: the things that are not lane boundaries, plus the
	// corrected bicycle symbol.
	"bicycle_symbol":            [1.00, 0.15, 0.15],
	"crossing":                  [0.55, 0.45, 0.95],
	"parking_marking":           [0.30, 0.75, 0.85],
	"hatched_marking":           [0.95, 0.60, 0.20],
	"arrow_marking":             [0.60, 0.90, 0.60],
	// Manual-review set: symbols with no lane, whose missing side is WHITE or
	// uncoloured paint. Drawn hot so they stand out against everything else --
	// the question they exist to answer is whether the yellow-only rule should
	// be relaxed, and that is a judgement made by looking.
	// Symbols the text filter kept and dropped, side by side, so the filter can
	// be judged rather than trusted.
	"bicycle_symbol_kept":       [0.15, 1.00, 0.35],
	"bicycle_symbol_dropped":    [0.65, 0.65, 0.70],
	"bicycle_symbol_vetoed":     [1.00, 0.45, 0.05],
	// Topology-repair pass: the parking footprints that now veto candidates,
	// the candidates they removed, and the pre-merge pieces of each lane.
	"parking_pattern":           [0.20, 0.55, 1.00],
	"bike_lane_parking_rejected":[1.00, 0.20, 0.80],
	"bike_lane_negative_glyph":  [1.00, 0.55, 0.10],
	"bike_lane_parking_topology":[0.85, 0.25, 0.95],
	"bike_lane_arrow_marking":   [0.95, 0.85, 0.15],
	"bike_lane_fragment":        [0.55, 0.85, 0.95],
	// outlines as measured, before display smoothing (lane_smooth.py)
	"bike_lane_raw":             [0.60, 0.60, 0.60],
	// Bicycle-lane sub-classes (all also in bike_lane_candidate / high / ...):
	// bus lanes shared with bicycles, bike boxes at signals, off-road paths.
	// Bus-only lanes are not bicycle lanes and have their own layer.
	"bike_lane_shared_bus":      [0.72, 0.35, 1.00],
	"bike_lane_bike_box":        [1.00, 0.45, 0.75],
	"bike_lane_off_road":        [0.20, 0.90, 0.65],
	"bike_lane_cycle_crossing":  [1.00, 0.95, 0.30],
	"bus_lane":                  [0.95, 0.25, 0.25],
	// Why a band was removed: one layer per rule, so a rule can be judged.
	"bike_lane_off_carriageway":        [0.65, 0.45, 0.30],
	"bike_lane_short_yellow_box":       [0.95, 0.55, 0.10],
	"bike_lane_yellow_paint_inside":    [0.95, 0.35, 0.60],
	"bike_lane_oblique_strokes_inside": [0.80, 0.45, 0.95],
	"bike_lane_inside_bus_lane":        [0.60, 0.55, 0.85],
	"bike_lane_bus_band_is_traffic_lane":   [0.50, 0.50, 0.50],
	"bike_lane_bus_band_without_lettering": [0.60, 0.60, 0.60],
	"bike_lane_bus_band_spans_lane_line":   [0.70, 0.70, 0.70],
	"bike_lane_bus_band_spans_kerb":        [0.55, 0.45, 0.40],
	// white-sided bands the white pass's guards turned down
	"bike_lane_white_without_pictogram":   [0.80, 0.85, 0.95],
	"bike_lane_white_twin_of_lane":        [0.55, 0.70, 0.95],
	"bike_lane_white_without_yellow_line": [0.65, 0.65, 0.80],
	"review_symbol":             [1.00, 0.10, 0.55],
	"review_other_rail":         [0.95, 0.95, 1.00],
	"review_corridor":           [1.00, 0.45, 0.85],
	"boundary_rejected":         [0.85, 0.30, 0.30],
	"rejected_stop_line":        [0.95, 0.35, 0.25],
	"rejected_parking_divider":  [0.95, 0.55, 0.20],
	"rejected_crossing_bar":     [0.90, 0.25, 0.55],
	"rejected_welded_no_paint":  [0.70, 0.35, 0.75],
	"rejected_transverse_other": [0.80, 0.40, 0.40],
	"rejected_off_carriageway":  [0.60, 0.45, 0.35],
	"landuse":   [0.5, 0.5, 0.5],
	"natural":   [0.0, 1.0, 0.0],
	"places":    [1.0, 0.0, 1.0],
	"points":    [0.0, 1.0, 1.0],
	"roads":     [1.0, 1.0, 0.0],
	"waterways": [0.0, 0.0, 1.0],
	"default":   [0.9, 0.6, 0.1],
};

function getColor(feature){
	let color = defaultColors[feature];

	if(!color){
		color = defaultColors["default"];
	}

	return color;
}


// How many vertices arrived without a Z, and what was used instead. A
// GeoPackage can carry 3D geometry that this reader hands back as 2D -- the
// coordinate simply has two components -- and the old fallback put those
// features at a hardcoded 20 m. On a Swiss survey in EPSG:2056 the ground is
// around 375 m, so that fallback does not look like a small error: it drops
// every feature 355 m below the point cloud. Falling back to the feature's own
// recorded height instead keeps flat ground features (markings, lanes, kerbs)
// where they belong, and the counter makes it obvious which path was taken.
const zStats = {withZ: 0, fromProperty: 0, fromDefault: 0};

function vertexZ(alt, feature){
	if(alt !== undefined && alt !== null && Number.isFinite(alt)){
		zStats.withZ++;
		return alt;
	}
	const p = (feature && feature.properties) || {};
	for(const key of ["z_mid", "z_min", "elevation", "z"]){
		const v = Number(p[key]);
		if(Number.isFinite(v)){
			zStats.fromProperty++;
			return v;
		}
	}
	zStats.fromDefault++;
	return 20;
}

function reportZ(source){
	const {withZ, fromProperty, fromDefault} = zStats;
	const total = withZ + fromProperty + fromDefault;
	if(total === 0) return;
	if(fromDefault > 0){
		console.warn(`[GeoPackage] ${source}: ${fromDefault} of ${total} vertices had ` +
			`no Z and no height attribute -- those are drawn at 20 m and will not ` +
			`line up with the point cloud. Add a z_mid column, or export 3D geometry.`);
	}else if(fromProperty > 0){
		console.log(`[GeoPackage] ${source}: ${fromProperty} of ${total} vertices took ` +
			`their height from a feature attribute (the reader returned 2D coordinates).`);
	}else{
		console.log(`[GeoPackage] ${source}: all ${total} vertices carried their own Z.`);
	}
	zStats.withZ = zStats.fromProperty = zStats.fromDefault = 0;
}

export class Geopackage{
	constructor(){
		this.path = null;
		this.node = null;
	}
};

export class GeoPackageLoader{

	constructor(){

	}


	/**
	 * Build the THREE objects for ONE table into `node`.
	 *
	 * Split out of `loadBuffer` so a table can be built when it is asked for
	 * rather than when the file is opened. The cost this defers is not the
	 * download -- it is one `Line2` per feature, each with its own geometry and
	 * its own draw call, and a network layer here runs to twenty thousand.
	 */
	static buildTable(data, table, node, transform){
		const dao = data.getFeatureDao(table);

		let boundingBox = dao.getBoundingBox();
		boundingBox.maxLatitude += 0.01;
		boundingBox.maxLongitude += 0.01;
		boundingBox.minLatitude -= 0.01;
		boundingBox.minLongitude -= 0.01;
		boundingBox = boundingBox.projectBoundingBox(dao.projection, 'EPSG:4326');

		// The box is the table's own extent, so the library's per-feature
		// check against it (skipVerification = false) has nothing to filter.
		// It does drop things, though: every Multi* geometry, and -- through
		// turf edge cases -- some plain lines and polygons (165 features over
		// the current project files, e.g. 19 of 431 in vevey_review.gpkg).
		const geoJson = dao.queryForGeoJSONIndexedFeaturesWithBoundingBox(boundingBox, true);

		// Vector features are painted ON the ground, so their Z is the DEM
		// height and the point cloud has points at exactly that height. With
		// depth testing on, the cloud wins the z-fight and the layer is
		// invisible however carefully it was built -- which is why the small
		// review polygons appeared to load and show nothing. Drawing them
		// without depth testing, after the cloud, puts them on top instead.
		//
		// `resolution` is what LineMaterial converts `linewidth` through, so a
		// hardcoded 1000x1000 makes lines the wrong width on every canvas that
		// is not square and 1000 px. Track the real canvas.
		const size = new THREE.Vector2(1000, 1000);
		try{
			if(window.viewer && window.viewer.renderer){
				window.viewer.renderer.getSize(size);
			}
		}catch(e){ /* keep the fallback */ }
		const matLine = new LineMaterial( {
			color: new THREE.Color().setRGB(...getColor(table)),
			linewidth: 3,
			resolution: size,
			dashed: false,
			depthTest: false,
			depthWrite: false,
			transparent: true
		} );
		GeoPackageLoader._materials = GeoPackageLoader._materials || [];
		GeoPackageLoader._materials.push(matLine);

		let n = 0;
		for(const feature of geoJson){
			const featureNode = GeoPackageLoader.featureToSceneNode(feature, matLine, dao.projection, transform);
			if(featureNode){
				// Draw after the point cloud. Without depth testing the order
				// is what decides, so this has to be explicit.
				featureNode.renderOrder = 10;
				featureNode.traverse(o => { o.renderOrder = 10; });
				node.add(featureNode);
				n++;
			}
		}
		return n;
	}

	/**
	 * Open a GeoPackage once per URL and hand back the same handle after that.
	 *
	 * Several lazy layers come from one file, and each would otherwise
	 * re-download and re-parse the whole thing the first time it is ticked.
	 */
	static openUrl(url){
		GeoPackageLoader._open = GeoPackageLoader._open || new Map();
		if(!GeoPackageLoader._open.has(url)){
			const p = (async () => {
				await Promise.all([
					Utils.loadScript(`${Potree.scriptPath}/lazylibs/geopackage/geopackage.js`),
					Utils.loadScript(`${Potree.scriptPath}/lazylibs/sql.js/sql-wasm.js`),
				]);
				const wasmPath = `${Potree.scriptPath}/lazylibs/sql.js/sql-wasm.wasm`;
				await initSqlJs({ locateFile: filename => wasmPath });
				const res = await fetch(url);
				// fetch only rejects on a network failure -- a 404 or a 500
				// resolves, and its HTML error body would reach geopackage.open
				// as a corrupt database with a far less obvious message.
				if(!res.ok){
					throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
				}
				const buf = await res.arrayBuffer();
				return geopackage.open(new Uint8Array(buf));
			})();
			// A cached rejected promise is permanent: every later tick would get
			// the same failure back without retrying, so a layer that missed a
			// transient error could never be loaded again in that session.
			// Drop the entry on failure and let the next tick try afresh.
			p.catch(() => GeoPackageLoader._open.delete(url));
			GeoPackageLoader._open.set(url, p);
		}
		return GeoPackageLoader._open.get(url);
	}

	/**
	 * A GeoPackage whose layers are listed but not built until they are ticked.
	 *
	 * Each table becomes an empty `Object3D`, so the sidebar lists it with an
	 * unchecked box; the first time anything sets `visible = true` the table is
	 * fetched and built. `visible` is intercepted rather than a new API added,
	 * because that is the property the existing tree handler already writes --
	 * nothing in the sidebar has to know these layers are different.
	 *
	 * `params.tables` may be supplied from a small manifest so the file itself
	 * is not downloaded until a layer is actually wanted.
	 */
	static async loadUrlLazy(url, params){
		params = params || {};
		params.source = url;
		const transform = params.transform || {forward: (arg) => arg};

		let tables = params.tables;
		if(!tables){
			const data = await GeoPackageLoader.openUrl(url);
			tables = data.getTables().features;
		}

		const geo = new Geopackage();
		geo.path = url;
		geo.node = new THREE.Object3D();
		geo.node.name = url;
		geo.node.potree = {source: url};

		for(const table of tables){
			const node = new THREE.Object3D();
			node.name = table;
			let shown = false, loading = false, built = false;
			Object.defineProperty(node, "visible", {
				get: () => shown,
				set: (v) => {
					shown = v;
					if(v && !built && !loading){
						loading = true;
						GeoPackageLoader.openUrl(url).then(data => {
							const n = GeoPackageLoader.buildTable(data, table, node, transform);
							built = true; loading = false;
							reportZ(`${url}#${table}`);
							console.log(`[GeoPackage] ${table}: built ${n} features on first display`);
						}).catch(err => {
							loading = false;
							console.error(`[GeoPackage] ${table} failed to load`, err);
						});
					}
				},
			});
			node.visible = false;
			geo.node.add(node);
		}

		return geo;
	}

	static async loadUrl(url, params){

		await Promise.all([
			Utils.loadScript(`${Potree.scriptPath}/lazylibs/geopackage/geopackage.js`),
			Utils.loadScript(`${Potree.scriptPath}/lazylibs/sql.js/sql-wasm.js`),
		]);
		
		const result = await fetch(url);
		// fetch only rejects on a network failure; a 404 or 500 would otherwise
		// reach geopackage.open as a corrupt database.
		if(!result.ok){
			throw new Error(`HTTP ${result.status} ${result.statusText} for ${url}`);
		}
		const buffer = await result.arrayBuffer();

		params = params || {};

		params.source = url;

		return GeoPackageLoader.loadBuffer(buffer, params);
	}

	static async loadBuffer(buffer, params){

		await Promise.all([
			Utils.loadScript(`${Potree.scriptPath}/lazylibs/geopackage/geopackage.js`),
			Utils.loadScript(`${Potree.scriptPath}/lazylibs/sql.js/sql-wasm.js`),
		]);

		params = params || {};

		// Plain async code, so that a failure to open or read the file rejects
		// the returned promise. (It used to run in an async Promise executor,
		// where a throw was swallowed and the promise never settled.)
		let transform = params.transform;
		if(!transform){
			transform = {forward: (arg) => arg};
		}

		const wasmPath = `${Potree.scriptPath}/lazylibs/sql.js/sql-wasm.wasm`;
		await initSqlJs({ locateFile: filename => wasmPath});

		const u8 = new Uint8Array(buffer);

		const data = await geopackage.open(u8);
		window.data = data;

		const geopackageNode = new THREE.Object3D();
		geopackageNode.name = params.source;
		geopackageNode.potree = {
			source: params.source,
		};

		const geo = new Geopackage();
		geo.path = params.source;
		geo.node = geopackageNode;

		const tables = data.getTables();

		for(const table of tables.features){
			const node = new THREE.Object3D();
			node.name = table;
			geo.node.add(node);
			GeoPackageLoader.buildTable(data, table, node, transform);
		}

		reportZ(params.source);

		return geo;
	}

	static featureToSceneNode(feature, matLine, geopackageProjection, transform){
		let geometry = feature.geometry;
		
		let color = new THREE.Color(1, 1, 1);
		
		if(feature.geometry.type === "Point"){
			let sg = new THREE.SphereGeometry(0.1, 18, 18);
			let sm = new THREE.MeshNormalMaterial();
			// let sm = new THREE.MeshBasicMaterial( { color: 0xffff00 } ); 
			let s = new THREE.Mesh(sg, sm);


			// let sg = new THREE.SphereGeometry(0.2, 4, 4);
			// let sm = new THREE.MeshBasicMaterial({side: THREE.BackSide});
			// sm.color = matLine.color

			let [long, lat, alt] = geometry.coordinates;
			let pos = transform.forward(geopackageProjection.forward([long, lat]));
			
			alt = vertexZ(alt, feature);
			// Use transformed coordinates
			pos = [pos[0], pos[1], alt];			

			
			s.position.set(...pos);
			
			s.scale.set(1, 1, 1);
			
			return s;
		}else if (geometry.type === "LineString") {
			let coordinates = [];
			let min = new THREE.Vector3(Infinity, Infinity, Infinity);
		
			for (let i = 0; i < geometry.coordinates.length; i++) {
				let [long, lat, alt] = geometry.coordinates[i];

				let pos = transform.forward(geopackageProjection.forward([long, lat]));
				
				alt = vertexZ(alt, feature);
				// Use transformed coordinates
				pos = [pos[0], pos[1], alt];

				min.x = Math.min(min.x, pos[0]);
				min.y = Math.min(min.y, pos[1]);
				min.z = Math.min(min.z, pos[2]);
		
				coordinates.push(...pos);
		
				if (i > 0 && i < geometry.coordinates.length - 1) {
					coordinates.push(...pos);
				}
			}
		
			// Normalize positions relative to the minimum point
			for (let i = 0; i < coordinates.length; i += 3) {
				coordinates[i + 0] -= min.x;
				coordinates[i + 1] -= min.y;
				coordinates[i + 2] -= min.z;
			}
		
			const lineGeometry = new LineGeometry();
			lineGeometry.setPositions(coordinates);
		
			const line = new Line2(lineGeometry, matLine);
			line.computeLineDistances();
			line.scale.set(1, 1, 1);
			line.position.copy(min);
		
			return line;
		}else if(geometry.type === "Polygon"){
			const rings = new THREE.Object3D();
			for(let pc of geometry.coordinates){
				let coordinates = [];
				
				let min = new THREE.Vector3(Infinity, Infinity, Infinity);
				for(let i = 0; i < pc.length; i++){
					let [long, lat, alt] = pc[i];

					let pos = transform.forward(geopackageProjection.forward([long, lat]));
					alt = vertexZ(alt, feature);
					// Use transformed coordinates
					pos = [pos[0], pos[1], alt];
	
					min.x = Math.min(min.x, pos[0]);
					min.y = Math.min(min.y, pos[1]);
					min.z = Math.min(min.z, pos[2]);
					
					coordinates.push(...pos);
					if(i > 0 && i < pc.length - 1){
						coordinates.push(...pos);
					}
				}
				
				for(let i = 0; i < coordinates.length; i += 3){
					coordinates[i+0] -= min.x;
					coordinates[i+1] -= min.y;
					coordinates[i+2] -= min.z;
				}

				const lineGeometry = new LineGeometry();
				lineGeometry.setPositions( coordinates );

				const line = new Line2( lineGeometry, matLine );
				line.computeLineDistances();
				line.scale.set( 1, 1, 1 );
				line.position.copy(min);

				rings.add(line);
			}
			// Every ring, not just the first. Returning inside the loop drew the
			// exterior and silently dropped the holes -- the road surface layer
			// alone has 231 of them, so traffic islands and roundabout centres
			// were rendered as filled road.
			return rings;
		}else if(geometry.type === "MultiPoint" || geometry.type === "MultiLineString" || geometry.type === "MultiPolygon"){
			// Draw every member with the single-geometry code above; the
			// feature's properties come along for the Z fallback.
			const memberType = geometry.type.slice("Multi".length);
			const members = new THREE.Object3D();
			for(const coordinates of geometry.coordinates){
				const member = GeoPackageLoader.featureToSceneNode(
					{...feature, geometry: {type: memberType, coordinates: coordinates}},
					matLine, geopackageProjection, transform);
				if(member){
					members.add(member);
				}
			}
			return members.children.length > 0 ? members : null;
		}else{
			console.log("unhandled feature: ", feature);
		}
	}

};