
import * as THREE from "../../../libs/three.js/build/three.module.js";
import { EventDispatcher } from "../../EventDispatcher.js";
import {TextSprite} from "../../TextSprite.js";

let sg = new THREE.SphereGeometry(1, 8, 8);
let sgHigh = new THREE.SphereGeometry(1, 128, 128);

let sm = new THREE.MeshBasicMaterial({side: THREE.BackSide, transparent: true, opacity: 0.75});
let smHovered = new THREE.MeshBasicMaterial({side: THREE.BackSide, color: 0xff0000});

let raycaster = new THREE.Raycaster();

/** Display mode that shows the photo itself; every other display mode is the id of a label set. */
const IMAGE_MODE = "image";

// sessionStorage keys, followed by the set's storageKey
const DISPLAY_MODE_PREFIX = "potree.images360.displayMode:";
const OPACITY_PREFIX = "potree.images360.pointCloudOpacity:";

/** Stands in for the point cloud scene in frames where the point clouds are fully transparent. */
const EMPTY_POINT_CLOUD_SCENE = new THREE.Scene();

let controlsCount = 0; // for unique element ids

const STYLE_ID = "potree-i360-style";
const STYLE = `
.potree-i360-bar{
	position: absolute; right: 10px; bottom: 10px; z-index: 10000;
	display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px;
	max-width: calc(100% - 20px); box-sizing: border-box; padding: 6px;
	border-radius: 8px; background: rgba(18, 20, 24, 0.82); color: #f1f3f5;
	box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
	font: 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
	user-select: none; -webkit-user-select: none;
}
.potree-i360-bar[hidden], .potree-i360-bar [hidden]{ display: none; }
.potree-i360-bar button{
	min-width: 36px; min-height: 34px; margin: 0; padding: 0 12px;
	border: 1px solid rgba(255, 255, 255, 0.28); border-radius: 6px;
	background: rgba(255, 255, 255, 0.08); color: inherit; font: inherit; cursor: pointer;
}
.potree-i360-bar button:hover:not(:disabled){ background: rgba(255, 255, 255, 0.2); }
.potree-i360-bar button:focus-visible{ outline: 2px solid #5aa9ff; outline-offset: 1px; }
.potree-i360-bar button:disabled{ opacity: 0.35; cursor: default; }
.potree-i360-modes, .potree-i360-nav{ display: inline-flex; align-items: center; }
.potree-i360-modes button{ border-radius: 0; margin-left: -1px; }
.potree-i360-modes button:first-child{ border-radius: 6px 0 0 6px; margin-left: 0; }
.potree-i360-modes button:last-child{ border-radius: 0 6px 6px 0; }
.potree-i360-modes button[aria-pressed="true"]{
	position: relative; background: #2f7de1; border-color: #2f7de1; color: #fff; font-weight: 600;
}
.potree-i360-modes button.potree-i360-unavailable[aria-pressed="true"]{
	background: #8a6a1c; border-color: #c99a2e; text-decoration: line-through;
}
.potree-i360-nav button{ font-size: 18px; line-height: 1; padding: 0 10px; }
.potree-i360-status{
	min-width: 7.5em; padding: 0 8px; text-align: center; white-space: nowrap;
	font-variant-numeric: tabular-nums;
}
.potree-i360-status.potree-i360-notice{ color: #ffd36b; }
.potree-i360-opacity{
	display: inline-flex; align-items: center; gap: 8px; min-height: 34px; padding: 0 4px;
	white-space: nowrap;
}
.potree-i360-opacity input{
	width: 110px; height: 34px; margin: 0; accent-color: #2f7de1; cursor: pointer;
}
.potree-i360-opacity input:focus-visible{ outline: 2px solid #5aa9ff; outline-offset: 1px; }
.potree-i360-opacity output{ min-width: 2.8em; text-align: left; font-variant-numeric: tabular-nums; }
/* the set is hidden in the scene tree: no panorama for the point clouds to be blended over */
.potree-i360-opacity.potree-i360-unavailable{ opacity: 0.4; }
.potree-i360-opacity input:disabled{ cursor: default; }
@media (pointer: coarse){
	.potree-i360-bar button{ min-width: 44px; min-height: 44px; }
	.potree-i360-opacity input{ width: 140px; height: 44px; }
}
@media (max-width: 480px){
	/* a row of its own, with a slider as wide as the row */
	.potree-i360-opacity{ flex: 1 1 100%; }
	.potree-i360-opacity input{ flex: 1 1 auto; width: auto; }
}
`;

function injectStyle(){
	if(document.getElementById(STYLE_ID)){
		return;
	}
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = STYLE;
	document.head.appendChild(style);
}

function createButton(text, onClick, title = null){
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = text;
	if(title){
		button.title = title;
		button.setAttribute("aria-label", title);
	}
	button.addEventListener("click", onClick);
	return button;
}

/** Whether keys typed into `target` are its own, e.g. text. A slider or a checkbox has no use for "[". */
function isEditableTarget(target){
	if(!target){
		return false;
	}
	if(target.tagName === "INPUT"){
		return !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/i.test(target.type);
	}
	return target.isContentEditable || /^(TEXTAREA|SELECT)$/.test(target.tagName);
}

function storeSetting(key, value){
	try{
		window.sessionStorage.setItem(key, value);
	}catch(e){ /* storage unavailable (private mode, sandbox): the choice still holds for this page */ }
}

function readSetting(key){
	try{
		return window.sessionStorage.getItem(key);
	}catch(e){
		return null;
	}
}

/**
 * The sets of 360° images whose spheres compete for the mouse: every set of the viewer's scene, plus
 * `images` itself, which may not have been added to the scene yet.
 */
function competingSets(images){
	const sets = images.viewer.scene.images360;
	return sets.includes(images) ? sets : [...sets, images];
}

/** Of `sets`, the one whose hovered sphere is the nearest to the camera; null if none is hovered. */
function nearestHovered(sets){
	let nearest = null;
	for(const set of sets){
		if(set._hovered && (!nearest || set._hovered.distance < nearest._hovered.distance)){
			nearest = set;
		}
	}
	return nearest;
}

/**
 * Starts loading one panorama (photo or label image) into a texture.
 *
 * Returns `{texture, state, promise, release}`. `state` goes from "loading" to "loaded" or "failed";
 * `release()` cancels a pending download, frees the GPU copy and turns the state into "released"
 * (the promise then rejects, so nothing waits forever).
 */
function loadPanorama(url){
	const texture = new THREE.Texture();
	texture.wrapS = THREE.RepeatWrapping;
	texture.repeat.x = -1;
	// Seen from the centre of the sphere a panorama is magnified at every usual field of view, so
	// mipmaps would never be sampled -- they would only add a third to the memory and to the upload.
	texture.generateMipmaps = false;
	texture.minFilter = THREE.LinearFilter;
	// JPEGs have no alpha channel (same rule as THREE.TextureLoader).
	texture.format = /\.jpe?g($|\?)/i.test(url) ? THREE.RGBFormat : THREE.RGBAFormat;

	const img = document.createElement("img");
	img.crossOrigin = "anonymous";

	const entry = {texture, state: "loading", promise: null, release: null};
	let rejectPromise = null;

	entry.promise = new Promise((resolve, reject) => {
		rejectPromise = reject;
		img.onload = () => {
			// decode() does the expensive JPEG decode off the main thread, before the texture upload.
			const decoded = typeof img.decode === "function" ? img.decode().catch(() => {}) : Promise.resolve();
			decoded.then(() => {
				if(entry.state !== "loading"){
					return;
				}
				texture.image = img;
				texture.needsUpdate = true;
				entry.state = "loaded";
				resolve(texture);
			});
		};
		img.onerror = () => {
			if(entry.state === "loading"){
				entry.state = "failed";
				reject(new Error(`Failed to load ${url}`));
			}
		};
	});

	entry.release = () => {
		const wasLoading = entry.state === "loading";
		entry.state = "released";
		img.onload = null;
		img.onerror = null;
		if(wasLoading){
			img.removeAttribute("src"); // cancels the download
			rejectPromise(new Error(`Released ${url}`));
		}
		texture.dispose();
	};

	img.src = url;

	return entry;
}

class Image360{

	/**
	 * @param {object} labels - `{labelSetId: url}` of the label images of this panorama.
	 */
	constructor(file, time, longitude, latitude, altitude, course, pitch, roll, labels = {}){
		this.file = file;
		this.time = time;
		this.longitude = longitude;
		this.latitude = latitude;
		this.altitude = altitude;
		this.course = course;
		this.pitch = pitch;
		this.roll = roll;
		this.mesh = null;
		this.labels = labels;
		// URL of the first label set, for code written against the single-label API.
		this.label = Object.values(labels)[0] || null;
	}
};

/**
 * A set of 360° panoramas.
 *
 * While an image is focused the panorama is shown on a large sphere around the camera, with a control bar
 * at the bottom right: the display mode (the photo or one of the label sets), the opacity of the point
 * clouds over the panorama, previous/next and unfocus. The display mode and the point cloud opacity belong
 * to the set, not to an image: they survive unfocus/focus and moving between images.
 *
 * Textures are loaded lazily -- only the one needed by the current display mode -- and only the focused
 * image's textures plus the one last shown of the previously focused image are kept; everything else is
 * released (download cancelled, GPU memory freed) as soon as the focus moves on. Panoramas reach 91 MP.
 *
 * Events: `visibility_changed`, `display_mode_changed` ({mode, previousMode}),
 * `point_cloud_opacity_changed` ({opacity, previousOpacity}).
 */
export class Images360 extends EventDispatcher{

	constructor(viewer){
		super();

		this.viewer = viewer;
		this.name = null;

		this.selectingEnabled = true;

		this.images = [];
		this.node = new THREE.Object3D();

		/** Label sets available for these images, `[{id, name}]` in display order. */
		this.labelSets = [];
		/** IMAGE_MODE ("image") or the id of a label set. */
		this.displayMode = IMAGE_MODE;
		/** Opacity of every point cloud over a panorama of this set: 0 (hidden) to 1 (opaque). */
		this.pointCloudOpacity = 1;
		/** When set, the display mode and point cloud opacity are remembered in sessionStorage under this key. */
		this.storageKey = null;

		// filename label sprite (always in front, screen-sized)
		this.label = new TextSprite("");
		this.label.visible = false;

		// 1. Disable depth testing so it ignores the Z-buffer (draws over occluding objects)
		this.label.sprite.material.depthTest = true;
		this.label.sprite.material.depthWrite = true;

		// 2. Set a high renderOrder on the ACTUAL sprite object to force it to draw last
		this.label.sprite.renderOrder = 99999;

		// 3. Keep size coupled to world scale so it matches scene nodes
		this.label.sprite.material.sizeAttenuation = true; // or false if you want fixed screen size
		this.node.add(this.label);

		// Own material: the panorama must not leak onto the small spheres, which share `sm`.
		this.sphere = new THREE.Mesh(sgHigh, new THREE.MeshBasicMaterial({
			side: THREE.BackSide,
			transparent: true,
			opacity: 0.75,
		}));
		this.sphere.visible = false;
		this.sphere.scale.set(1000, 1000, 1000);
		this.node.add(this.sphere);
		this._visible = true;

		this.focusedImage = null;

		// hovering, see update()
		this._hovered = null;     // {object, distance}: this set's nearest sphere under the mouse, last frame
		this._highlighted = null; // the sphere mesh currently drawn highlighted

		// texture bookkeeping, see _releaseTextures()
		this._textures = new Map(); // Image360 -> Map(kind -> entry), kind = IMAGE_MODE | label set id
		this._shown = null;         // {image, kind} currently on the sphere
		this._previous = null;      // {image, kind} last shown of an image that is no longer focused

		this._previousView = null;  // camera to restore on unfocus
		this._loading = false;      // the texture for the focused image is still loading
		this._notice = "";          // message about the focused image, shown in the control bar
		this._fallback = false;     // the selected label set is not available, the photo is shown instead
		this._frameOverrides = [];  // {object, key, value} to restore when the frame is rendered

		this._createControls();

		viewer.addEventListener("update", () => {
			this.update(viewer);
			this._prepareFrame();
		});
		viewer.addEventListener("render.pass.begin", () => this._beginFrame());
		viewer.addEventListener("render.pass.end", () => this._restoreFrame());
		viewer.inputHandler.addInputListener(this);

		// Every set receives the mousedown; only the set whose sphere is the nearest one under the mouse
		// focuses it -- an image of its own.
		this.addEventListener("mousedown", () => {
			if(this._hovered && nearestHovered(competingSets(this)) === this){
				this.focus(this._hovered.object.image360);
			}
		});

		// A double click inside the 360° view cycles the display mode. A double click whose first click
		// enters the view (by focusing a sphere) must only focus, so the dblclick handler needs to know
		// whether an image was focused when the gesture started. That is recorded before the InputHandler
		// sees the mousedown (and may focus): capturing on the canvas' parent runs before the InputHandler's
		// listener on the canvas. `detail` counts the clicks of the gesture; only its first one counts.
		const canvas = viewer.renderer.domElement;
		this._focusedAtGestureStart = false;
		canvas.parentElement.addEventListener("mousedown", (e) => {
			if(e.target === canvas && e.detail <= 1){
				this._focusedAtGestureStart = this.focusedImage !== null;
			}
		}, true);
		canvas.addEventListener("dblclick", () => {
			if(this.focusedImage && this._focusedAtGestureStart){
				this.cycleDisplayMode();
			}
		});

		window.addEventListener("keydown", (e) => this._onKeyDown(e));
	};

	set visible(visible){
		if(this._visible === visible){
			return;
		}


		for(const image of this.images){
			image.mesh.visible = visible && (this.focusedImage == null);
		}

		this.sphere.visible = visible && (this.focusedImage != null) && (this._shown != null);
		this._visible = visible;
		this._updateControls();
		this.dispatchEvent({
			type: "visibility_changed",
			images: this,
		});
	}

	get visible(){
		return this._visible;
	}

	getDisplayMode(){
		return this.displayMode;
	}

	/**
	 * @param {string} mode - "image" or the id of one of `labelSets`.
	 * @returns {boolean} false if the mode is unknown.
	 */
	setDisplayMode(mode){
		if(mode !== IMAGE_MODE && !this.labelSets.some(set => set.id === mode)){
			console.warn(`Images360: unknown display mode "${mode}"`);
			return false;
		}
		if(mode === this.displayMode){
			return true;
		}

		const previousMode = this.displayMode;
		this.displayMode = mode;

		if(this.storageKey){
			storeSetting(DISPLAY_MODE_PREFIX + this.storageKey, mode);
		}

		this._showFocused();

		this.dispatchEvent({
			type: "display_mode_changed",
			images: this,
			mode: mode,
			previousMode: previousMode,
		});

		return true;
	}

	/** image -> first label set -> ... -> last label set -> image */
	cycleDisplayMode(){
		const modes = [IMAGE_MODE, ...this.labelSets.map(set => set.id)];
		const next = modes[(modes.indexOf(this.displayMode) + 1) % modes.length];
		return this.setDisplayMode(next);
	}

	getPointCloudOpacity(){
		return this.pointCloudOpacity;
	}

	/**
	 * Sets the opacity of the point clouds over the panorama while one of these images is focused and its
	 * panorama is on screen. It replaces, only for those frames, the clouds' own opacity and the EDL
	 * opacity, which stay as they are.
	 * @param {number} opacity - 0 (hidden) to 1 (opaque); clamped to that range.
	 * @returns {boolean} false if `opacity` is not a number.
	 */
	setPointCloudOpacity(opacity){
		opacity = Number(opacity);
		if(!Number.isFinite(opacity)){
			console.warn(`Images360: invalid point cloud opacity "${opacity}"`);
			return false;
		}
		opacity = Math.min(Math.max(opacity, 0), 1);
		if(opacity === this.pointCloudOpacity){
			return true;
		}

		const previousOpacity = this.pointCloudOpacity;
		this.pointCloudOpacity = opacity;

		if(this.storageKey){
			storeSetting(OPACITY_PREFIX + this.storageKey, String(opacity));
		}

		this._updateOpacityControl();

		this.dispatchEvent({
			type: "point_cloud_opacity_changed",
			images: this,
			opacity: opacity,
			previousOpacity: previousOpacity,
		});

		return true;
	}

	/**
	 * Whether the point clouds are drawn with `pointCloudOpacity`: while one of these images is focused and
	 * a panorama is on the sphere. Until the focused image's panorama has loaded, if it fails to load and
	 * while the set is hidden in the scene tree, there is no panorama to blend the clouds over: they keep
	 * their own opacity, so that the view is never left empty. Moving from image to image keeps the
	 * previous panorama up until the next one is ready, so the override does not flicker then.
	 *
	 * The opacity replaces the clouds' own for each frame only: every value set through _overrideForFrame()
	 * is put back at render.pass.end, so the clouds' opacity, the EDL settings and the sidebar controls
	 * showing them are left alone, and a cloud added or shown while focused is covered from its first frame.
	 *
	 * With EDL (the default) the clouds are drawn opaque into a render target that the EDL pass blends over
	 * the scene -- the panorama -- with `viewer.edlOpacity`; their material opacity is ignored. Without EDL
	 * the PotreeRenderer draws a cloud whose opacity is below 1 additively, without depth, under the
	 * half-transparent panorama sphere, which shows hardly any of it; the high quality splats ignore opacity.
	 * So frames that need blending go through the EDL renderer -- with an EDL strength of 0 when EDL is off,
	 * which keeps the look of the clouds.
	 */
	_isOverridingPointClouds(){
		// The sphere is visible only once a texture is applied, and never while the set is hidden.
		return this.focusedImage !== null && this.sphere.visible;
	}

	/** On the viewer's update, before the frame's renderer is picked. */
	_prepareFrame(){
		this._restoreFrame(); // a frame that was not rendered, or not to the end
		const viewer = this.viewer;
		const opacity = this.pointCloudOpacity;
		if(this._isOverridingPointClouds() && opacity > 0 && opacity < 1){
			if(viewer.useHQ){
				this._overrideForFrame(viewer, "useHQ", false);
			}
			if(!viewer.useEDL){
				this._overrideForFrame(viewer, "useEDL", true);
				this._overrideForFrame(viewer, "edlStrength", 0);
			}
		}
	}

	/** On render.pass.begin. */
	_beginFrame(){
		if(!this._isOverridingPointClouds()){
			return;
		}
		const scene = this.viewer.scene;
		const opacity = this.pointCloudOpacity;

		this._overrideForFrame(this.viewer, "edlOpacity", opacity);
		// The uniform rather than `material.opacity`, whose setter rebuilds the shader and fires events.
		for(const pointcloud of scene.pointclouds){
			const uniform = pointcloud.material && pointcloud.material.uniforms.uOpacity;
			if(uniform){
				this._overrideForFrame(uniform, "value", opacity);
			}
		}

		if(opacity === 0){
			// Nothing to blend: the renderers get a point cloud scene without the clouds, which skips
			// drawing them. `pointcloud.visible`, which drives loading and the scene tree, is untouched.
			this._overrideForFrame(scene, "scenePointCloud", EMPTY_POINT_CLOUD_SCENE);
		}
	}

	_overrideForFrame(object, key, value){
		this._frameOverrides.push({object, key, value: object[key]});
		object[key] = value;
	}

	/** On render.pass.end: puts back what was overridden for the frame, last change first. */
	_restoreFrame(){
		const overrides = this._frameOverrides;
		while(overrides.length > 0){
			const {object, key, value} = overrides.pop();
			object[key] = value;
		}
	}

	/**
	 * Focuses the next image in coordinates-file order. Stops at the last image rather than wrapping
	 * around: the first and the last panorama of a survey are usually far apart.
	 * @returns {Image360|null} the newly focused image, or null if nothing is focused or at the end.
	 */
	focusNext(){
		return this._focusOffset(1);
	}

	/** Like focusNext(), backwards; stops at the first image. */
	focusPrevious(){
		return this._focusOffset(-1);
	}

	_focusOffset(step){
		if(!this.focusedImage){
			return null;
		}
		const image = this.images[this.images.indexOf(this.focusedImage) + step];
		if(!image){
			return null;
		}
		this.focus(image);
		return image;
	}

	focus(image360){
		if(!image360 || image360 === this.focusedImage){
			return;
		}
		if(!this.images.includes(image360)){
			// focusing another set's image would leave this set's position and previous/next meaningless
			console.warn("Images360: focus() ignores an image of another set", image360.file);
			return;
		}

		const viewer = this.viewer;
		const view = viewer.scene.view;
		const target = new THREE.Vector3(...image360.position);
		let direction;

		if(this.focusedImage === null){
			// Entering the 360° view. If another set is focused, take over from it so that unfocus still
			// returns to the view from before the first focus.
			let previousView = null;
			for(const other of viewer.scene.images360){
				if(other !== this && other.focusedImage){
					previousView = other._previousView;
					other.unfocus({restoreView: false});
				}
			}

			this._previousView = previousView || {
				controls: viewer.controls,
				position: view.position.clone(),
				target: view.getPivot(),
			};

			viewer.setControls(viewer.orbitControls);
			viewer.orbitControls.doubleClockZoomEnabled = false;

			for(let image of this.images){
				image.mesh.visible = false;
			}

			this.selectingEnabled = false;
			this.sphere.visible = false;

			direction = target.clone().sub(view.position).normalize();
		}else{
			// Moving from image to image: keep looking the same way. The current panorama stays on
			// screen until the next one is ready.
			direction = view.direction;
		}

		if(!(direction.lengthSq() > 0)){
			direction = new THREE.Vector3(0, 1, 0);
		}

		this.focusedImage = image360;
		this._releaseTextures();

		let newCamPos = target.clone().sub(direction.multiplyScalar(0.000001));

		view.setView(
			newCamPos,
			target,
			500
		);

		this._showFocused();
	}

	/**
	 * @param {object} [options]
	 * @param {boolean} [options.restoreView=true] - false keeps the camera and controls where they are.
	 */
	unfocus({restoreView = true} = {}){
		if(this.focusedImage === null){
			return;
		}

		this.selectingEnabled = true;

		for(let image of this.images){
			image.mesh.visible = this._visible;
		}

		this.sphere.material.map = null;
		this.sphere.material.needsUpdate = true;
		this.sphere.visible = false;

		if(this._shown){
			this._previous = this._shown;
		}
		this._shown = null;
		this.focusedImage = null;
		this._loading = false;
		this._notice = "";
		this._fallback = false;
		this._releaseTextures();

		if(restoreView && this._previousView){
			this.viewer.orbitControls.doubleClockZoomEnabled = true;
			this.viewer.setControls(this._previousView.controls);

			this.viewer.scene.view.setView(
				this._previousView.position,
				this._previousView.target,
				500
			);
		}
		this._previousView = null;

		this.label.visible = false;

		this._updateControls();
	}

	/**
	 * Shows the texture that the focused image needs for the current display mode, loading it first if
	 * necessary. Falls back to the photo, keeping the display mode, when the image has no label of the
	 * selected set or that label cannot be loaded. Safe to call at any time; it is called again whenever
	 * one of the focused image's textures settles.
	 */
	_showFocused(){
		const image = this.focusedImage;
		if(!image){
			return;
		}

		let kind = this.displayMode;
		this._notice = "";
		this._fallback = false;

		if(kind !== IMAGE_MODE){
			const entries = this._textures.get(image);
			const known = entries ? entries.get(kind) : null;
			if(!image.labels[kind] || (known && known.state === "failed")){
				const set = this.labelSets.find(s => s.id === kind);
				this._notice = `No ${set ? set.name : kind} label, showing image`;
				this._fallback = true;
				kind = IMAGE_MODE;
			}
		}

		const entry = this._getTexture(image, kind);
		this._loading = entry.state === "loading";

		if(entry.state === "loaded"){
			this._applyTexture(image, kind, entry.texture);
		}else if(entry.state === "failed"){
			// Nothing to show for this image: do not leave the previous panorama up as if it were this one.
			this._notice = "Image could not be loaded";
			this.sphere.visible = false;
			this.sphere.material.map = null;
			this.sphere.material.needsUpdate = true;
			this._shown = null;
			this._releaseTextures();
		}

		this._updateControls();
	}

	_getTexture(image, kind){
		let entries = this._textures.get(image);
		if(!entries){
			entries = new Map();
			this._textures.set(image, entries);
		}

		let entry = entries.get(kind);
		if(!entry){
			entry = loadPanorama(kind === IMAGE_MODE ? image.file : image.labels[kind]);
			entries.set(kind, entry);

			// A texture that settles after the focus moved on is ignored here; by then it has been
			// released (or is kept as the previous image's) by _releaseTextures().
			const settled = () => {
				if(this.focusedImage === image){
					this._showFocused();
				}
			};
			entry.promise.then(settled, settled);
		}

		return entry;
	}

	_applyTexture(image, kind, texture){
		const material = this.sphere.material;
		if(material.map !== texture){
			material.map = texture;
			material.needsUpdate = true;
		}

		{ // orientation
			let {course, pitch, roll} = image;
			this.sphere.rotation.set(
				THREE.Math.degToRad(+roll + 90),
				THREE.Math.degToRad(-pitch),
				THREE.Math.degToRad(-course + 90),
				"ZYX"
			);
		}

		this.sphere.position.set(...image.position);
		this.sphere.visible = this._visible;

		if(this._shown && this._shown.image !== image){
			this._previous = this._shown;
		}
		this._shown = {image, kind};
		this._releaseTextures();
	}

	/**
	 * Keeps every texture of the focused image, the one on the sphere and the one last shown of the
	 * previously focused image; releases all others, including downloads still in flight.
	 */
	_releaseTextures(){
		const isKept = (image, kind, entry) => {
			if(image === this.focusedImage){
				return true;
			}
			for(const keep of [this._shown, this._previous]){
				if(keep && keep.image === image && keep.kind === kind && entry.state === "loaded"){
					return true;
				}
			}
			return false;
		};

		for(const [image, entries] of this._textures){
			for(const [kind, entry] of entries){
				if(!isKept(image, kind, entry)){
					entry.release();
					entries.delete(kind);
				}
			}
			if(entries.size === 0){
				this._textures.delete(image);
			}
		}
	}

	/** Restores the display mode and the point cloud opacity remembered under `storageKey`, if any. */
	_restoreSettings(){
		if(!this.storageKey){
			return;
		}

		const mode = readSetting(DISPLAY_MODE_PREFIX + this.storageKey);
		if(mode && (mode === IMAGE_MODE || this.labelSets.some(set => set.id === mode))){
			this.displayMode = mode;
		}

		const opacity = parseFloat(readSetting(OPACITY_PREFIX + this.storageKey));
		if(opacity >= 0 && opacity <= 1){
			this.pointCloudOpacity = opacity;
			this._updateOpacityControl();
		}
	}

	_createControls(){
		injectStyle();

		const bar = document.createElement("div");
		bar.className = "potree-i360-bar";
		bar.setAttribute("role", "toolbar");
		bar.setAttribute("aria-label", "360° image");
		bar.hidden = true;

		this.elModes = document.createElement("div");
		this.elModes.className = "potree-i360-modes";
		this.elModes.setAttribute("role", "group");
		this.elModes.setAttribute("aria-label", "Display");
		this._modesKey = null;

		const nav = document.createElement("div");
		nav.className = "potree-i360-nav";
		this.elPrevious = createButton("‹", () => this.focusPrevious(), "Previous image ([)");
		this.elNext = createButton("›", () => this.focusNext(), "Next image (])");
		this.elStatus = document.createElement("span");
		this.elStatus.className = "potree-i360-status";
		this.elStatus.setAttribute("aria-live", "polite");
		nav.append(this.elPrevious, this.elStatus, this.elNext);

		this.elUnfocus = createButton("unfocus", () => this.unfocus());
		this.elUnfocus.title = "Leave the 360° view";

		bar.append(this.elModes, this._createOpacityControl(), nav, this.elUnfocus);
		this.elBar = bar;

		this.domRoot = this.viewer.renderer.domElement.parentElement;
		this.domRoot.appendChild(bar);
	}

	/** The "Point cloud" opacity slider, 0 - 100 %. */
	_createOpacityControl(){
		const id = `potree-i360-opacity-${++controlsCount}`;

		const group = document.createElement("div");
		group.className = "potree-i360-opacity";

		const label = document.createElement("label");
		label.htmlFor = id;
		label.textContent = "Point cloud";

		const slider = document.createElement("input");
		slider.type = "range";
		slider.id = id;
		slider.min = "0";
		slider.max = "100";
		slider.step = "1";
		slider.setAttribute("aria-label", "Point cloud opacity");
		slider.addEventListener("input", () => this.setPointCloudOpacity(slider.valueAsNumber / 100));

		const value = document.createElement("output");
		value.setAttribute("for", id);
		value.setAttribute("aria-hidden", "true"); // the slider's aria-valuetext says the same

		group.append(label, slider, value);
		this.elOpacityGroup = group;
		this.elOpacity = slider;
		this.elOpacityValue = value;
		this._updateOpacityControl();

		return group;
	}

	_updateOpacityControl(){
		const percent = Math.round(this.pointCloudOpacity * 100);
		const text = `${percent}%`;
		this.elOpacity.value = String(percent);
		this.elOpacity.setAttribute("aria-valuetext", text);
		this.elOpacityValue.textContent = text;
	}

	_updateControls(){
		const image = this.focusedImage;
		this.elBar.hidden = !image;
		if(!image){
			return;
		}

		const modes = [{id: IMAGE_MODE, name: "Image"}, ...this.labelSets];
		const modesKey = JSON.stringify(modes.map(m => [m.id, m.name]));
		if(modesKey !== this._modesKey){
			this._modesKey = modesKey;
			this.elModes.textContent = "";
			for(const mode of modes){
				const button = createButton(mode.name, () => this.setDisplayMode(mode.id));
				button.dataset.mode = mode.id;
				this.elModes.appendChild(button);
			}
		}
		this.elModes.hidden = this.labelSets.length === 0;

		for(const button of this.elModes.children){
			const active = button.dataset.mode === this.displayMode;
			const unavailable = active && this._fallback;
			button.setAttribute("aria-pressed", String(active));
			button.classList.toggle("potree-i360-unavailable", unavailable);
			button.title = unavailable ? "Not available for this image" : "";
		}

		// With the set hidden in the scene tree there is no panorama for the clouds to be blended over
		// (see _isOverridingPointClouds()): the slider would have no effect, and its value would not be
		// the one the clouds are drawn with. While a panorama loads, or after one failed, it stays usable:
		// the status says why the clouds are opaque, and the value applies to the next panorama shown.
		const hidden = !this._visible;
		this.elOpacity.disabled = hidden;
		this.elOpacityGroup.classList.toggle("potree-i360-unavailable", hidden);
		this.elOpacityGroup.title = hidden
			? "360° images are hidden"
			: "Opacity of the point cloud over the 360° image";

		const index = this.images.indexOf(image);
		this.elPrevious.disabled = index <= 0;
		this.elNext.disabled = index < 0 || index >= this.images.length - 1;

		const position = `${index + 1} / ${this.images.length}`;
		let message = this._notice;
		if(hidden){
			message = "360° images hidden";
		}else if(this._loading){
			message = "Loading…";
		}
		this.elStatus.textContent = message ? `${position} · ${message}` : position;
		this.elStatus.classList.toggle("potree-i360-notice", hidden || (!this._loading && this._notice !== ""));
		this.elStatus.title = image.file.split("/").pop();
	}

	_onKeyDown(e){
		if(!this.focusedImage || e.defaultPrevented || isEditableTarget(e.target)){
			return;
		}
		// Ctrl/Cmd shortcuts belong to the browser. Ctrl+Alt is AltGr, which types "[" and "]" on
		// many European keyboards.
		if(e.metaKey || (e.ctrlKey && !e.altKey)){
			return;
		}

		if(e.key === "["){
			this.focusPrevious();
		}else if(e.key === "]"){
			this.focusNext();
		}else if(e.key === "l" || e.key === "L"){
			this.cycleDisplayMode();
		}else{
			return;
		}
		e.preventDefault();
	}

	/** Hit-tests this set's spheres: `_hovered` becomes the nearest one under the mouse, or null. */
	handleHovering(){
		const viewer = this.viewer;
		let mouse = viewer.inputHandler.mouse;
		let camera = viewer.scene.getActiveCamera();
		let domElement = viewer.renderer.domElement;

		let ray = Potree.Utils.mouseToRay(mouse, camera, domElement.clientWidth, domElement.clientHeight);

		raycaster.ray.copy(ray);
		// Ignore label and sphere; only pick clickable image meshes -- and only
		// ones that are actually drawn. THREE's raycaster does not skip
		// invisible objects, so without the `visible` test the spheres stayed
		// hoverable and clickable after their layer was unticked: they vanished
		// from the render but still lit up a label and still swallowed the
		// click that should have gone to the point cloud behind them.
		const pickables = this.node.children.filter(c => c.image360 && c.visible);
		let intersections = raycaster.intersectObjects(pickables);

		this._hovered = intersections.length > 0
			? {object: intersections[0].object, distance: intersections[0].distance}
			: null;
	}

	/** Draws `hit.object`, one of this set's spheres, highlighted and labelled with its file name; null clears. */
	_highlight(hit){
		const mesh = hit ? hit.object : null;
		if(this._highlighted && this._highlighted !== mesh){
			this._highlighted.material = sm;
		}
		this._highlighted = mesh;
		this.label.visible = mesh !== null;
		if(!mesh){
			return;
		}

		mesh.material = smHovered;

		// 1. Update the text (TextSprite makes a new texture for every new text; free the old one)
		const oldLabelTexture = this.label.texture;
		this.label.setText(mesh.image360.file.split("/").pop());
		if(oldLabelTexture && oldLabelTexture !== this.label.texture){
			oldLabelTexture.dispose();
		}

		// 2. Force the sprite settings AFTER setText, in case setText resets the material
		const sprite = this.label.sprite;
		sprite.renderOrder = 99999;           // Force draw last
		sprite.material.depthTest = true;    // Ignore objects in front
		sprite.material.depthWrite = true;   // Don't write to depth buffer
		sprite.material.transparent = true;   // Ensure it's treated as a transparent object for sorting

		// 3. Position the label
		mesh.getWorldPosition(this.label.position);
	}

	update(){

		// A hidden or focused set is not a target: the mousedown listener focuses what `_hovered` points
		// at, so leaving it null here is what actually disarms the click.
		this._hovered = null;
		if(this.selectingEnabled && this._visible){
			this.handleHovering();
		}

		// Spheres of several sets can be under the mouse at once: only the nearest of them is highlighted,
		// as only that one opens on a click. Every set's update re-applies the choice to all sets, so once
		// the last set has updated in a frame the highlight reflects every set's hit of that frame.
		const sets = competingSets(this);
		const nearest = nearestHovered(sets);
		for(const set of sets){
			set._highlight(set === nearest ? set._hovered : null);
		}

	}

};


function joinUrl(base, relativePath){
	let b = String(base).replace(/\/+$/, "");
	let r = String(relativePath).replace(/\\/g, "/").replace(/^\/+/, "");
	return r ? `${b}/${r}` : b;
}

export class Images360Loader{

	/**
	 * @param {string} imagesBaseUrl - Base URL for coordinates.txt and image files. The `File` column in
	 *   coordinates.txt is a path relative to this URL (may include subfolders).
	 * @param {object} params
	 * @param {Array<{id?: string, name?: string, baseUrl: string}>} [params.labelSets] - Label sets the
	 *   viewer can switch between. Each label image uses the **same** relative path as `File` under the
	 *   set's `baseUrl`. `id` defaults to the name (or "labelsN"), `name` to the id.
	 * @param {string} [params.labelsBaseUrl] - Legacy single label set (ignored when `labelSets` is given);
	 *   becomes the set `{id: "label", name: "Label"}`.
	 * @param {string} [params.name] - Display name of the set of images (e.g. in the scene tree).
	 * @param {object} [params.transform] - `{forward([x, y]) -> [x, y]}` from the coordinates file's CRS to
	 *   the scene's; identity by default.
	 * @param {string} [params.coordinatesFile] - Default `coordinates.txt`, resolved under `imagesBaseUrl`.
	 * @param {boolean} [params.legacyPotreePaths] - If true, use old `pano/` + `label/` layout (see Potree examples).
	 * @param {string|null} [params.coordinatesSubdir] - Legacy only: subdirectory for coordinates file.
	 * @param {string|null} [params.imagesSubdir] - Legacy only: subdirectory prefix for images.
	 * @param {string|null} [params.labelsSubdir] - Legacy only: subdirectory for labels (null disables).
	 */
	static async load(imagesBaseUrl, viewer, params = {}){

		const transform = params.transform || {
			forward: a => a,
		};

		const coordinatesFile = params.coordinatesFile || "coordinates.txt";
		const legacy = params.legacyPotreePaths === true;

		let coordinatesUrl;
		let resolveImageUrl;
		// [{id, name, resolve(rel) -> url}]
		const labelSets = [];

		if(legacy){
			const coordinatesSubdir = params.coordinatesSubdir !== undefined ? params.coordinatesSubdir : "pano";
			const imagesSubdir = params.imagesSubdir !== undefined ? params.imagesSubdir : "pano";
			const labelsSubdir = params.labelsSubdir !== undefined ? params.labelsSubdir : "label";

			coordinatesUrl = coordinatesSubdir
				? joinUrl(imagesBaseUrl, `${coordinatesSubdir}/${coordinatesFile}`)
				: joinUrl(imagesBaseUrl, coordinatesFile);

			resolveImageUrl = (rel) => {
				const p = rel.replace(/\\/g, "/");
				return imagesSubdir ? joinUrl(imagesBaseUrl, `${imagesSubdir}/${p}`) : joinUrl(imagesBaseUrl, p);
			};

			if(labelsSubdir !== null){
				labelSets.push({id: "label", name: "Label", resolve: (rel) => {
					const p = rel.replace(/\\/g, "/").split("/").pop();
					return labelsSubdir ? joinUrl(imagesBaseUrl, `${labelsSubdir}/${p}`) : joinUrl(imagesBaseUrl, p);
				}});
			}
		} else {
			coordinatesUrl = joinUrl(imagesBaseUrl, coordinatesFile);
			resolveImageUrl = (rel) => joinUrl(imagesBaseUrl, rel);

			const labelsBase = params.labelsBaseUrl != null && String(params.labelsBaseUrl).trim() !== ""
				? String(params.labelsBaseUrl).replace(/\/+$/, "")
				: null;

			if(labelsBase){
				labelSets.push({id: "label", name: "Label", resolve: (rel) => joinUrl(labelsBase, rel)});
			}
		}

		if(Array.isArray(params.labelSets) && params.labelSets.length > 0){
			labelSets.length = 0;
			for(const [i, set] of params.labelSets.entries()){
				const baseUrl = set && set.baseUrl != null ? String(set.baseUrl).trim() : "";
				if(!baseUrl){
					console.warn(`Images360Loader: label set ${i} has no baseUrl and is ignored`, set);
					continue;
				}
				let id = String(set.id || set.name || `labels${i + 1}`);
				for(let n = 2; id === IMAGE_MODE || labelSets.some(s => s.id === id); n++){
					id = `${String(set.id || set.name || "labels")}-${n}`;
				}
				labelSets.push({
					id: id,
					name: String(set.name || id),
					resolve: (rel) => joinUrl(baseUrl, rel),
				});
			}
		}

		let response = await fetch(coordinatesUrl);
		if(!response.ok){
			throw new Error(`Images360Loader: HTTP ${response.status} ${response.statusText} for ${coordinatesUrl}`);
		}
		let text = await response.text();

		let lines = text.split(/\r?\n/);
		let coordinateLines = lines.slice(1);

		let images360 = new Images360(viewer);
		images360.name = params.name || null;
		images360.labelSets = labelSets.map(({id, name}) => ({id, name}));

		const orientation = (v) => Number.isFinite(v) ? v : 0;
		let skipped = 0;

		for(let line of coordinateLines){

			if(line.trim().length === 0){
				continue;
			}

			let tokens = line.split(/\t/);

			let [filename, time, long, lat, alt, course, pitch, roll] = tokens;
			time = parseFloat(time);
			long = parseFloat(long);
			lat = parseFloat(lat);
			alt = parseFloat(alt);
			course = orientation(parseFloat(course));
			pitch = orientation(parseFloat(pitch));
			roll = orientation(parseFloat(roll));

			let rel = String(filename).replace(/"/g, "").trim();
			if(!rel || !Number.isFinite(long) || !Number.isFinite(lat) || !Number.isFinite(alt)){
				skipped++;
				continue;
			}

			let file = resolveImageUrl(rel);
			const labels = {};
			for(const set of labelSets){
				const url = set.resolve(rel);
				if(url){
					labels[set.id] = url;
				}
			}

			let image360 = new Image360(file, time, long, lat, alt, course, pitch, roll, labels);

			let xy = transform.forward([long, lat]);
			let position = [...xy, alt];
			image360.position = position;

			images360.images.push(image360);
		}

		if(skipped > 0){
			console.warn(`Images360Loader: skipped ${skipped} malformed line(s) in ${coordinatesUrl}`);
		}

		try{
			images360.storageKey = new URL(coordinatesUrl, document.baseURI).href;
		}catch(e){
			images360.storageKey = coordinatesUrl;
		}
		images360._restoreSettings();

		Images360Loader.createSceneNodes(images360, transform);

		return images360;

	}

	static createSceneNodes(images360, transform){

		for(let image360 of images360.images){
			let {longitude, latitude, altitude} = image360;
			let xy = transform.forward([longitude, latitude]);

			let mesh = new THREE.Mesh(sg, sm);
			mesh.position.set(...xy, altitude);
			mesh.scale.set(1, 1, 1);
			mesh.image360 = image360;

			{ // orientation
				var {course, pitch, roll} = image360;
				mesh.rotation.set(
					THREE.Math.degToRad(+roll + 90),
					THREE.Math.degToRad(-pitch),
					THREE.Math.degToRad(-course + 90),
					"ZYX"
				);
			}

			images360.node.add(mesh);

			image360.mesh = mesh;
		}
	}



};

