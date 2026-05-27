
import * as THREE from "../../../libs/three.js/build/three.module.js";
import { Annotation } from "../../Annotation.js";
import { EventDispatcher } from "../../EventDispatcher.js";
import {TextSprite} from "../../TextSprite.js";

let sg = new THREE.SphereGeometry(1, 8, 8);
let sgHigh = new THREE.SphereGeometry(1, 128, 128);

let sm = new THREE.MeshBasicMaterial({side: THREE.BackSide});
let smHovered = new THREE.MeshBasicMaterial({side: THREE.BackSide, color: 0xff0000});

let raycaster = new THREE.Raycaster();
let currentlyHovered = null;

let previousView = {
	controls: null,
	position: null,
	target: null,
};

class Image360{

	constructor(file, time, longitude, latitude, altitude, course, pitch, roll, label){
		this.file = file;
		this.time = time;
		this.longitude = longitude;
		this.latitude = latitude;
		this.altitude = altitude;
		this.course = course;
		this.pitch = pitch;
		this.roll = roll;
		this.mesh = null;
		this.label = label;
	}
};

export class Images360 extends EventDispatcher{

	constructor(viewer){
		super();

		this.viewer = viewer;

		this.selectingEnabled = true;

		this.images = [];
		this.node = new THREE.Object3D();

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

		this.sphere = new THREE.Mesh(sgHigh, sm);
		this.sphere.visible = false;
		this.sphere.scale.set(1000, 1000, 1000);
		this.node.add(this.sphere);
		this._visible = true;
		// this.node.add(label);

		this.focusedImage = null;
		this.showingLabel = false;

		let elUnfocus = document.createElement("input");
		elUnfocus.type = "button";
		elUnfocus.value = "unfocus";
		elUnfocus.style.position = "absolute";
		elUnfocus.style.right = "10px";
		elUnfocus.style.bottom = "10px";
		elUnfocus.style.zIndex = "10000";
		elUnfocus.style.fontSize = "2em";
		elUnfocus.addEventListener("click", () => this.unfocus());
		this.elUnfocus = elUnfocus;

		let elToggle = document.createElement("input");
		elToggle.type = "button";
		elToggle.value = "show label";
		elToggle.style.position = "absolute";
		elToggle.style.right = "10px";
		elToggle.style.bottom = "60px";
		elToggle.style.zIndex = "10000";
		elToggle.style.fontSize = "2em";
		elToggle.addEventListener("click", () => this.toggleLabel());
		this.elToggle = elToggle;

		this.domRoot = viewer.renderer.domElement.parentElement;
		this.domRoot.appendChild(elUnfocus);
		this.domRoot.appendChild(elToggle);
		this.elUnfocus.style.display = "none";
		this.elToggle.style.display = "none";

		viewer.addEventListener("update", () => {
			this.update(viewer);
		});
		viewer.inputHandler.addInputListener(this);

		this.addEventListener("mousedown", () => {
			if(currentlyHovered && currentlyHovered.image360){
				this.focus(currentlyHovered.image360);
			}
		});

		viewer.renderer.domElement.addEventListener("dblclick", () => {
			if(this.focusedImage){
				this.toggleLabel();
			}
		});
		
	};

	set visible(visible){
		if(this._visible === visible){
			return;
		}


		for(const image of this.images){
			image.mesh.visible = visible && (this.focusedImage == null);
		}

		this.sphere.visible = visible && (this.focusedImage != null);
		this._visible = visible;
		this.dispatchEvent({
			type: "visibility_changed",
			images: this,
		});
	}

	get visible(){
		return this._visible;
	}

	focus(image360){
		if(this.focusedImage !== null){
			this.unfocus();
		}

		previousView = {
			controls: this.viewer.controls,
			position: this.viewer.scene.view.position.clone(),
			target: this.viewer.scene.view.getPivot(),
		};

		this.viewer.setControls(this.viewer.orbitControls);
		this.viewer.orbitControls.doubleClockZoomEnabled = false;

		for(let image of this.images){
			image.mesh.visible = false;
		}

		this.selectingEnabled = false;

		this.sphere.visible = false;

		this.showingLabel = false;
		this.elToggle.value = "show label";

		this.load(image360).then( () => {
			this.sphere.visible = true;
			this.sphere.material.map = image360.texture;
			this.sphere.material.needsUpdate = true;

			if(image360.label_texture){
				this.elToggle.style.display = "";
			}
		});

		{ // orientation
			let {course, pitch, roll} = image360;
			this.sphere.rotation.set(
				THREE.Math.degToRad(+roll + 90),
				THREE.Math.degToRad(-pitch),
				THREE.Math.degToRad(-course + 90),
				"ZYX"
			);
		}

		this.sphere.position.set(...image360.position);

		let target = new THREE.Vector3(...image360.position);
		let dir = target.clone().sub(this.viewer.scene.view.position).normalize();
		let move = dir.multiplyScalar(0.000001);
		let newCamPos = target.clone().sub(move);

		this.viewer.scene.view.setView(
			newCamPos, 
			target,
			500
		);

		this.focusedImage = image360;

		this.elUnfocus.style.display = "";
	}

	unfocus(){
		this.selectingEnabled = true;

		for(let image of this.images){
			image.mesh.visible = true;
		}

		let image = this.focusedImage;

		if(image === null){
			return;
		}


		this.sphere.material.map = null;
		this.sphere.material.needsUpdate = true;
		this.sphere.visible = false;

		let pos = this.viewer.scene.view.position;
		let target = this.viewer.scene.view.getPivot();
		let dir = target.clone().sub(pos).normalize();
		let move = dir.multiplyScalar(10);
		let newCamPos = target.clone().sub(move);

		this.viewer.orbitControls.doubleClockZoomEnabled = true;
		this.viewer.setControls(previousView.controls);

		this.viewer.scene.view.setView(
			previousView.position, 
			previousView.target,
			500
		);

		this.label.visible = false;

		this.showingLabel = false;
		this.focusedImage = null;

		this.elUnfocus.style.display = "none";
		this.elToggle.style.display = "none";
	}

	toggleLabel(){
		if(!this.focusedImage){
			return;
		}

		let image360 = this.focusedImage;

		if(this.showingLabel){
			this.sphere.material.map = image360.texture;
			this.showingLabel = false;
			this.elToggle.value = "show label";
		} else {
			if(!image360.label_texture){
				console.warn("No label available for this image");
				return;
			}
			this.sphere.material.map = image360.label_texture;
			this.showingLabel = true;
			this.elToggle.value = "show image";
		}

		this.sphere.material.needsUpdate = true;
	}

	load(image360){
		const promises = [];

		promises.push(new Promise(resolve => {
			let texture = new THREE.TextureLoader().load(image360.file, resolve);
			texture.wrapS = THREE.RepeatWrapping;
			texture.repeat.x = -1;
			image360.texture = texture;
		}));

		if(image360.label){
			promises.push(new Promise(resolve => {
				let label_texture = new THREE.TextureLoader().load(image360.label, resolve);
				label_texture.wrapS = THREE.RepeatWrapping;
				label_texture.repeat.x = -1;
				image360.label_texture = label_texture;
			}));
		} else {
			image360.label_texture = null;
		}

		return Promise.all(promises);
	}

	handleHovering(){
		const viewer = this.viewer;
		let mouse = viewer.inputHandler.mouse;
		let camera = viewer.scene.getActiveCamera();
		let domElement = viewer.renderer.domElement;

		let ray = Potree.Utils.mouseToRay(mouse, camera, domElement.clientWidth, domElement.clientHeight);

		// let tStart = performance.now();
		raycaster.ray.copy(ray);
		// ignore label and sphere; only pick clickable image meshes
		const pickables = this.node.children.filter(c => c.image360);
		let intersections = raycaster.intersectObjects(pickables);

		if(intersections.length === 0){
			return;
		}

		let intersection = intersections[0];
		currentlyHovered = intersection.object;
		currentlyHovered.material = smHovered;
		
		// 1. Update the text
		this.label.visible = true;
		this.label.setText(currentlyHovered.image360.file.split("/").pop());

		// 2. Force the sprite settings AFTER setText, in case setText resets the material
		const sprite = this.label.sprite;
		sprite.renderOrder = 99999;           // Force draw last
		sprite.material.depthTest = true;    // Ignore objects in front
		sprite.material.depthWrite = true;   // Don't write to depth buffer
		sprite.material.transparent = true;   // Ensure it's treated as a transparent object for sorting

		// 3. Position the label
		currentlyHovered.getWorldPosition(this.label.position);
	}

	update(){

		let {viewer} = this;

		if(currentlyHovered){
			currentlyHovered.material = sm;
			currentlyHovered = null;
		}
		this.label.visible = false;

		if(this.selectingEnabled){
			this.handleHovering();
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
	 * @param {string} [params.labelsBaseUrl] - Optional. If set, label assets use the **same** relative path
	 *   as `File` under this base (identical folder structure and filename).
	 * @param {string} [params.coordinatesFile] - Default `coordinates.txt`, resolved under `imagesBaseUrl`.
	 * @param {boolean} [params.legacyPotreePaths] - If true, use old `pano/` + `label/` layout (see Potree examples).
	 * @param {string|null} [params.coordinatesSubdir] - Legacy only: subdirectory for coordinates file.
	 * @param {string|null} [params.imagesSubdir] - Legacy only: subdirectory prefix for images.
	 * @param {string|null} [params.labelsSubdir] - Legacy only: subdirectory for labels (null disables).
	 */
	static async load(imagesBaseUrl, viewer, params = {}){

		if(!params.transform){
			params.transform = {
				forward: a => a,
			};
		}

		const coordinatesFile = params.coordinatesFile || "coordinates.txt";
		const legacy = params.legacyPotreePaths === true;

		let coordinatesUrl;
		let resolveImageUrl;
		let resolveLabelUrl;

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

			resolveLabelUrl = (rel) => {
				if(labelsSubdir === null){
					return null;
				}
				const p = rel.replace(/\\/g, "/").split("/").pop();
				if(labelsSubdir){
					return joinUrl(imagesBaseUrl, `${labelsSubdir}/${p}`);
				}
				return joinUrl(imagesBaseUrl, p);
			};
		} else {
			coordinatesUrl = joinUrl(imagesBaseUrl, coordinatesFile);

			const labelsBase = params.labelsBaseUrl != null && String(params.labelsBaseUrl).trim() !== ""
				? String(params.labelsBaseUrl).replace(/\/+$/, "")
				: null;

			resolveImageUrl = (rel) => joinUrl(imagesBaseUrl, rel);
			resolveLabelUrl = (rel) => (labelsBase ? joinUrl(labelsBase, rel) : null);
		}

		let response = await fetch(coordinatesUrl);
		let text = await response.text();

		let lines = text.split(/\r?\n/);
		let coordinateLines = lines.slice(1);

		let images360 = new Images360(viewer);

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
			course = parseFloat(course);
			pitch = parseFloat(pitch);
			roll = parseFloat(roll);

			let rel = filename.replace(/"/g, "").trim();
			let file = resolveImageUrl(rel);
			let label = resolveLabelUrl(rel);

			let image360 = new Image360(file, time, long, lat, alt, course, pitch, roll, label);

			let xy = params.transform.forward([long, lat]);
			let position = [...xy, alt];
			image360.position = position;

			images360.images.push(image360);
		}

		Images360Loader.createSceneNodes(images360, params.transform);

		return images360;

	}

	static createSceneNodes(images360, transform){

		for(let image360 of images360.images){
			let {longitude, latitude, altitude} = image360;
			let xy = transform.forward([longitude, latitude]);

			let mesh = new THREE.Mesh(sg, sm);
			mesh.position.set(...xy, altitude);
			mesh.scale.set(1, 1, 1);
			mesh.material.transparent = true;
			mesh.material.opacity = 0.75;
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


