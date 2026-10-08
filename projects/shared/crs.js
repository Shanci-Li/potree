/**
 * Built-in coordinate reference systems for Potree projects.
 *
 * Shared by the browser (projects/shared/project-viewer.js) and Node
 * (server/), so nothing here may touch browser-only globals at module scope.
 *
 * A project names its CRS (`"crs": "EPSG:2056"`); the proj4 definition comes
 * from the project's own `crsDefs` first and from this table otherwise.
 * The EPSG:2056 and EPSG:2154 strings are the exact ones the viewer already
 * uses (src/viewer/map.js and the legacy project pages), so transforms built
 * here match what those pages produced.
 */

export const CRS_LIST = [
	{
		name: "EPSG:2056",
		title: "CH1903+ / LV95 (Switzerland)",
		proj4: "+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs +type=crs",
	},
	{
		name: "EPSG:21781",
		title: "CH1903 / LV03 (Switzerland, legacy)",
		proj4: "+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=600000 +y_0=200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs +type=crs",
	},
	{
		name: "EPSG:2154",
		title: "RGF93 / Lambert-93 (France)",
		proj4: "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
	},
	{
		name: "EPSG:4326",
		title: "WGS 84 (longitude / latitude)",
		proj4: "+proj=longlat +datum=WGS84 +no_defs +type=crs",
	},
	{
		name: "EPSG:3857",
		title: "WGS 84 / Pseudo-Mercator (web maps)",
		proj4: "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs",
	},
	{
		name: "EPSG:32631",
		title: "WGS 84 / UTM zone 31N",
		proj4: "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs",
	},
	{
		name: "EPSG:32632",
		title: "WGS 84 / UTM zone 32N",
		proj4: "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs +type=crs",
	},
	{
		name: "EPSG:32633",
		title: "WGS 84 / UTM zone 33N",
		proj4: "+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs +type=crs",
	},
	{
		name: "EPSG:25831",
		title: "ETRS89 / UTM zone 31N",
		proj4: "+proj=utm +zone=31 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
	},
	{
		name: "EPSG:25832",
		title: "ETRS89 / UTM zone 32N",
		proj4: "+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
	},
	{
		name: "EPSG:25833",
		title: "ETRS89 / UTM zone 33N",
		proj4: "+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
	},
];

/**
 * Canonical spelling of a CRS name: trims, upper-cases the authority prefix
 * ("epsg:2056" -> "EPSG:2056") and turns a bare code ("2056") into "EPSG:2056".
 * Returns null for null/empty input.
 */
export function normalizeCrsName(name){
	if(name === null || name === undefined){
		return null;
	}
	const s = String(name).trim();
	if(s === ""){
		return null;
	}
	if(/^\d+$/.test(s)){
		return `EPSG:${s}`;
	}
	const m = s.match(/^([a-z]+):(.+)$/i);
	return m ? `${m[1].toUpperCase()}:${m[2]}` : s;
}

/**
 * proj4 definition string for `name`, or null when it is unknown.
 * `extraDefs` (a project's `crsDefs`) takes precedence over the built-in table.
 */
export function getProj4(name, extraDefs = {}){
	if(name === null || name === undefined){
		return null;
	}
	const defs = extraDefs || {};
	if(typeof defs[name] === "string" && defs[name].trim() !== ""){
		return defs[name];
	}
	const key = normalizeCrsName(name);
	if(key === null){
		return null;
	}
	for(const [defName, def] of Object.entries(defs)){
		if(normalizeCrsName(defName) === key && typeof def === "string" && def.trim() !== ""){
			return def;
		}
	}
	const known = CRS_LIST.find(crs => crs.name === key);
	return known ? known.proj4 : null;
}

/**
 * Registers the built-in table, then the project's `crsDefs` (so they win),
 * in the given proj4 instance.
 *
 * `crsDefs` entries are optional extras, so one that proj4 cannot parse (a
 * WKT string — this proj4 build reads proj4 strings only — or plain garbage)
 * is skipped instead of thrown: it must not take the whole project down.
 *
 * Returns `{crsDefs, rejected}`: `crsDefs` holds only the entries that
 * registered — pass it to getProj4() instead of `project.crsDefs`, so a
 * rejected name falls back to the built-in table or counts as unknown —
 * and `rejected` lists `{name, error}` for the others (`name` null when
 * `crsDefs` as a whole is not an object).
 */
export function registerCrs(proj4lib, project = {}){
	for(const crs of CRS_LIST){
		proj4lib.defs(crs.name, crs.proj4);
	}

	const crsDefs = {};
	const rejected = [];
	const extra = project.crsDefs;
	if(extra === null || extra === undefined){
		return {crsDefs, rejected};
	}
	if(typeof extra !== "object" || Array.isArray(extra)){
		rejected.push({name: null, error: "crsDefs must be an object {name: proj4 string}"});
		return {crsDefs, rejected};
	}

	for(const [name, def] of Object.entries(extra)){
		if(def === null || def === undefined || def === ""){
			continue;
		}
		if(typeof def !== "string" || def.trim() === ""){
			rejected.push({name, error: "not a proj4 string"});
			continue;
		}
		try{
			proj4lib.defs(name, def);
			const canonical = normalizeCrsName(name);
			if(canonical !== name){
				proj4lib.defs(canonical, def);
			}
			crsDefs[name] = def;
		}catch(err){
			rejected.push({name, error: def.trim().startsWith("+")
				? (err && err.message) || String(err)
				: "expected a proj4 string \"+proj=…\"; WKT is not supported"});
		}
	}
	return {crsDefs, rejected};
}
