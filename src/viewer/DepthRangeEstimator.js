import * as THREE from "../../libs/three.js/build/three.module.js";
import {DepthCurve} from "../materials/PointCloudMaterial.js";

// Number of intervals of the depth quantile tables.
const TABLE_SIZE = 64;
// Intervals of the equalized curve, matching uDepthQuantiles[17] in pointcloud.vs.
const EQUALIZED_SEGMENTS = 16;
// Fewer probe samples than this (e.g. a view of the sky) keep the previous estimate.
const MIN_SAMPLES = 64;
// Bins of the ln(depth) histogram the quantiles are taken from (linear time, unlike sorting).
const HISTOGRAM_BINS = 2048;
// The probe stores ln(depth) quantised to 24 bits in the RGB bytes of an RGBA8
// target (packProbeDepth() in pointcloud.vs, keep in sync): code 0 means no
// point, codes 1 to 2^24 - 1 span ln(depth) from PROBE_LOG_MIN to PROBE_LOG_MAX,
// i.e. depths from 0.05 mm to 485,000 km in relative steps of 1.8e-6.
const PROBE_LOG_MIN = -10;
const PROBE_LOG_MAX = 20;
const PROBE_LOG_STEP = (PROBE_LOG_MAX - PROBE_LOG_MIN) / (2 ** 24 - 2);

//
// Fits the grey range of the "depth" colour mode to what is actually on screen.
//
// A low-resolution probe pass (Renderer.renderDepthProbe) writes the view-space
// depth of the visible points into an RGBA8 target, which unlike a float target
// every WebGL device can render to and read back. It is drawn at a limited
// rate, mostly while the view or the loaded points change, and read back at the
// start of the next frame, when the GPU has usually finished it. Its depths are
// reduced to a table of log-depth quantiles, which is smoothed over time so
// that the range glides instead of jumping while navigating.
//
// Every visible point cloud in depth mode then gets
//  - with material.depthAutoRange: the [lowerPercentile, upperPercentile] depths
//    of the probe as uDepthRange,
//  - with DepthCurve.EQUALIZED: the quantiles of the visible depths inside its
//    range as uDepthQuantiles.
// All point clouds share one estimate so that equal depths get equal greys.
// Without an estimate (too few points on screen, or no usable probe target),
// the auto range is the renderer's fallback, the depths of the visible node
// bounds, so that uDepthRange always holds the range actually drawn.
//
export class DepthRangeEstimator{

	constructor(viewer){
		this.viewer = viewer;

		this.lowerPercentile = 0.02;
		this.upperPercentile = 0.98;
		this.probeWidth = 160;				// px, the height follows the aspect ratio
		this.probePointBudget = 500 * 1000;	// per point cloud
		this.minProbeInterval = 100;		// ms between probes while the view changes
		this.maxProbeInterval = 1000;		// ms between probes of a still view (filters, loading)
		this.timeConstant = 0.2;			// s, exponential smoothing of the range
		this.notifyInterval = 100;			// ms between "depth_range_changed" events of a material

		this.enabled = true;				// false if the probe target cannot be rendered to
		this.target = null;
		this.pixels = null;
		this.samples = null;
		this.histogram = new Uint32Array(HISTOGRAM_BINS);
		this.unnotified = new WeakSet();	// materials whose auto range changed since their last "depth_range_changed"
		this.notifyTimes = new WeakMap();	// material -> time of its last "depth_range_changed"

		this.reset();
	}

	reset(){
		this.pending = false;			// a probe was drawn and waits to be read back
		this.measured = null;			// ln(depth) at TABLE_SIZE + 1 evenly spaced percentiles of the last probe
		this.smoothed = null;			// the same, smoothed over time
		this.lastProbeTime = -Infinity;
		this.lastUpdateTime = null;
		this.probedSignature = null;
	}

	// Called once per frame, before the scene is rendered.
	update(camera){
		const pointclouds = this.viewer.scene.pointclouds
			.filter(pc => pc.visible && pc.material.activeAttributeName === "depth");

		if(pointclouds.length === 0){
			if(this.measured || this.pending){
				this.reset();
			}
			return;
		}

		const now = performance.now();

		if(this.enabled){
			this.probe(camera, pointclouds, now);
		}

		this.smooth(now);

		for(const pointcloud of pointclouds){
			this.apply(pointcloud, camera);
			this.notify(pointcloud.material, now);
		}
	}

	// Reads back the pending probe and draws a new one when it is due.
	probe(camera, pointclouds, now){
		if(this.pending){
			this.readProbe();
		}

		const signature = this.viewSignature(camera, pointclouds);
		const changed = !this.probedSignature
			|| signature.length !== this.probedSignature.length
			|| signature.some((value, i) => value !== this.probedSignature[i]);
		const elapsed = now - this.lastProbeTime;

		if((changed && elapsed >= this.minProbeInterval) || elapsed >= this.maxProbeInterval){
			this.probedSignature = signature;
			this.lastProbeTime = now;

			if(this.drawProbe(camera, pointclouds) && !this.smoothed){
				// nothing to show yet: wait for the result instead of using a guess
				this.readProbe();
			}
		}
	}

	// What the probe depends on: camera, viewport and the loaded visible points.
	viewSignature(camera, pointclouds){
		const size = this.viewer.renderer.getSize(new THREE.Vector2());
		const signature = [
			...camera.matrixWorld.elements,
			...camera.projectionMatrix.elements,
			size.x, size.y,
		];

		for(const pointcloud of pointclouds){
			signature.push(pointcloud.visibleNodes.length, pointcloud.numVisiblePoints);
		}

		return signature;
	}

	// Draws a probe; false if the estimator had to be switched off instead.
	drawProbe(camera, pointclouds){
		const size = this.viewer.renderer.getSize(new THREE.Vector2());
		const width = this.probeWidth;
		const height = Math.max(1, Math.round(width * size.y / Math.max(size.x, 1)));

		if(!this.target){
			this.target = this.createTarget(width, height);

			if(!this.target){
				this.enabled = false;
				console.warn("Potree: the depth probe target is not supported; the auto range of the depth colour mode falls back to the visible node bounds.");
				return false;
			}
		}else if(this.target.width !== width || this.target.height !== height){
			this.target.setSize(width, height);
		}

		this.viewer.pRenderer.renderDepthProbe(pointclouds, camera, this.target, this.probePointBudget);
		this.pending = true;

		return true;
	}

	// RGBA8 colour with a 16-bit depth buffer is the one framebuffer WebGL 1
	// guarantees to be complete; the check only guards against broken contexts.
	createTarget(width, height){
		const renderer = this.viewer.renderer;
		const gl = renderer.getContext();
		const target = new THREE.WebGLRenderTarget(width, height, {
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
			format: THREE.RGBAFormat,
			type: THREE.UnsignedByteType,
			depthBuffer: true,
			stencilBuffer: false,
		});
		target.texture.name = "Potree.DepthRangeProbe";

		const oldTarget = renderer.getRenderTarget();
		renderer.setRenderTarget(target);
		const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
		renderer.setRenderTarget(oldTarget);

		if(!complete){
			target.dispose();
			return null;
		}

		return target;
	}

	readProbe(){
		this.pending = false;

		const {width, height} = this.target;
		const numPixels = width * height;

		if(!this.pixels || this.pixels.length !== 4 * numPixels){
			this.pixels = new Uint8Array(4 * numPixels);
			this.samples = new Float32Array(numPixels);
		}

		const {pixels, samples} = this;
		this.viewer.renderer.readRenderTargetPixels(this.target, 0, 0, width, height, pixels);

		// decode ln(depth), see PROBE_LOG_MIN
		let numSamples = 0;
		let minLog = Infinity;
		let maxLog = -Infinity;
		for(let i = 0; i < numPixels; i++){
			const code = (pixels[4 * i] << 16) | (pixels[4 * i + 1] << 8) | pixels[4 * i + 2];

			if(code > 0){
				const logDepth = PROBE_LOG_MIN + (code - 1) * PROBE_LOG_STEP;
				samples[numSamples++] = logDepth;
				minLog = Math.min(minLog, logDepth);
				maxLog = Math.max(maxLog, logDepth);
			}
		}

		if(numSamples < MIN_SAMPLES){
			return;
		}

		const counts = this.histogram.fill(0);
		const scale = maxLog > minLog ? HISTOGRAM_BINS / (maxLog - minLog) : 0;
		for(let i = 0; i < numSamples; i++){
			counts[Math.min(Math.floor((samples[i] - minLog) * scale), HISTOGRAM_BINS - 1)]++;
		}

		// quantiles, interpolated inside their bin
		const table = this.measured || new Float64Array(TABLE_SIZE + 1);
		let bin = 0;
		let below = 0;	// samples in the bins before `bin`
		for(let i = 0; i <= TABLE_SIZE; i++){
			const rank = (i / TABLE_SIZE) * (numSamples - 1) + 0.5;

			while(below + counts[bin] < rank && bin < HISTOGRAM_BINS - 1){
				below += counts[bin];
				bin++;
			}

			const fraction = counts[bin] > 0 ? (rank - below) / counts[bin] : 0;
			table[i] = scale > 0 ? minLog + (bin + fraction) / scale : minLog;
		}

		this.measured = table;
	}

	smooth(now){
		if(!this.measured){
			return;
		}

		if(!this.smoothed){
			this.smoothed = Float64Array.from(this.measured);
		}else{
			const dt = (now - this.lastUpdateTime) / 1000;
			const weight = 1 - Math.exp(-dt / this.timeConstant);

			for(let i = 0; i <= TABLE_SIZE; i++){
				this.smoothed[i] += weight * (this.measured[i] - this.smoothed[i]);
			}
		}

		this.lastUpdateTime = now;
	}

	// ln(depth) at percentile p in [0, 1] of the smoothed distribution.
	logDepthAt(p){
		const x = Math.min(Math.max(p, 0), 1) * TABLE_SIZE;
		const i = Math.min(Math.floor(x), TABLE_SIZE - 1);
		const f = x - i;

		return (1 - f) * this.smoothed[i] + f * this.smoothed[i + 1];
	}

	// Percentile in [0, 1] of ln(depth) in the smoothed distribution.
	percentileOf(logDepth){
		const table = this.smoothed;

		if(logDepth <= table[0]){
			return 0;
		}else if(logDepth >= table[TABLE_SIZE]){
			return 1;
		}

		let i = 0;
		while(table[i + 1] < logDepth){
			i++;
		}

		const span = table[i + 1] - table[i];
		const f = span > 0 ? (logDepth - table[i]) / span : 0;

		return (i + f) / TABLE_SIZE;
	}

	apply(pointcloud, camera){
		const material = pointcloud.material;

		if(!this.smoothed){
			// No estimate: the renderer falls back to the depths of the visible node
			// bounds (Renderer.setDepthShadeUniforms). Keep that range in the material
			// too, so that the panel shows, and switching auto off keeps, what is drawn.
			material.depthRangeEstimated = false;

			if(material.depthAutoRange){
				const [near, far] = this.viewer.pRenderer.getCurrentViewDepthRange(pointcloud, pointcloud.visibleNodes, camera);
				this.setAutoRange(material, near, far);
			}

			return;
		}

		let [near, far] = material.depthRangeInUse;

		if(material.depthAutoRange){
			near = Math.max(Math.exp(this.logDepthAt(this.lowerPercentile)), camera.near);
			far = Math.exp(this.logDepthAt(this.upperPercentile));
			// keep a minimum span: a wall seen head-on would otherwise turn its noise into full contrast
			far = Math.max(far, near * 1.02 + 0.01);

			this.setAutoRange(material, near, far);
		}

		if(material.depthCurve === DepthCurve.EQUALIZED){
			this.equalize(material.uniforms.uDepthQuantiles.value, near, far);
		}

		material.depthRangeEstimated = true;
	}

	// Sets the auto range of `material`, ignoring changes too small to see.
	setAutoRange(material, near, far){
		const [oldNear, oldFar] = material.depthRangeInUse;
		const relativeChange = Math.max(Math.abs(near - oldNear) / oldNear, Math.abs(far - oldFar) / oldFar);

		if(!(relativeChange < 1e-4)){
			material.uniforms.uDepthRange.value = [near, far];
			this.unnotified.add(material);
		}
	}

	// Depths at 0, 1/16, ..., 16/16 of the visible depths inside [near, far];
	// log-spaced where there are no visible depths to equalize.
	equalize(quantiles, near, far){
		const logNear = Math.log(Math.max(near, 1e-6));
		const logFar = Math.log(Math.max(far, near * (1 + 1e-6), 1e-6));
		const p0 = this.percentileOf(logNear);
		const p1 = this.percentileOf(logFar);
		const useData = p1 - p0 > 0.01;

		quantiles[0] = Math.exp(logNear);
		for(let i = 1; i < EQUALIZED_SEGMENTS; i++){
			const w = i / EQUALIZED_SEGMENTS;
			const logDepth = useData
				? this.logDepthAt(p0 + w * (p1 - p0))
				: logNear + w * (logFar - logNear);

			quantiles[i] = Math.max(Math.exp(logDepth), quantiles[i - 1]);
		}
		quantiles[EQUALIZED_SEGMENTS] = Math.max(Math.exp(logFar), quantiles[EQUALIZED_SEGMENTS - 1]);
	}

	// Tells listeners (the properties panel) about a changed auto range, throttled.
	notify(material, now){
		const last = this.notifyTimes.has(material) ? this.notifyTimes.get(material) : -Infinity;

		if(!this.unnotified.has(material) || now - last < this.notifyInterval){
			return;
		}

		this.unnotified.delete(material);
		this.notifyTimes.set(material, now);
		material.dispatchEvent({type: "depth_range_changed", target: material});
	}
}
