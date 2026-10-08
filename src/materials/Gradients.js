import * as THREE from "../../libs/three.js/build/three.module.js";

// -------------------------------------------
// to get a ready to use gradient array from a chroma.js gradient:
// http://gka.github.io/chroma.js/
// -------------------------------------------
//
// let stops = [];
// for(let i = 0; i <= 10; i++){
//	let range = chroma.scale(['yellow', 'navy']).mode('lch').domain([10,0])(i)._rgb
//		.slice(0, 3)
//		.map(v => (v / 255).toFixed(4))
//		.join(", ");
//
//	let line = `[${i / 10}, new THREE.Color(${range})],`;
//
//	stops.push(line);
// }
// stops.join("\n");
//
//
//
// -------------------------------------------
// to get a ready to use gradient array from matplotlib:
// -------------------------------------------
// import matplotlib.pyplot as plt
// import matplotlib.colors as colors
//
// norm = colors.Normalize(vmin=0,vmax=1)
// cmap = plt.cm.viridis
//
// for i in range(0,11):
//	u = i / 10
//	rgb = cmap(norm(u))[0:3]
//	rgb = ["{0:.3f}".format(v) for v in rgb]
//	rgb = "[" + str(u) + ", new THREE.Color(" +  ", ".join(rgb) + ")],"
//	print(rgb)

let Gradients = {
	// From chroma spectral http://gka.github.io/chroma.js/
	// SPECTRAL: [
	// 	[0, new THREE.Color(0.3686, 0.3098, 0.6353)],
	// 	[0.1, new THREE.Color(0.1961, 0.5333, 0.7412)],
	// 	[0.2, new THREE.Color(0.4000, 0.7608, 0.6471)],
	// 	[0.3, new THREE.Color(0.6706, 0.8667, 0.6431)],
	// 	[0.4, new THREE.Color(0.9020, 0.9608, 0.5961)],
	// 	[0.5, new THREE.Color(1.0000, 1.0000, 0.7490)],
	// 	[0.6, new THREE.Color(0.9961, 0.8784, 0.5451)],
	// 	[0.7, new THREE.Color(0.9922, 0.6824, 0.3804)],
	// 	[0.8, new THREE.Color(0.9569, 0.4275, 0.2627)],
	// 	[0.9, new THREE.Color(0.8353, 0.2431, 0.3098)],
	// 	[1, new THREE.Color(0.6196, 0.0039, 0.2588)]
	// ],
	SPECTRAL: [
		[0, new THREE.Color(0.5,  0.25,  0.5)],
		[0.1428, new THREE.Color(0.95,  0.14,  0.91)],
		[0.2857, new THREE.Color(0.86, 0.08, 0.24)],
		[0.4285, new THREE.Color(0.0,  0.0,  0.56)],
		[0.5714, new THREE.Color(0.28,  0.28,  0.28)],
		[0.7142, new THREE.Color(0.6,  0.6,  0.6)],
		[0.8571, new THREE.Color(0.60,  0.98, 0.60)],
		[1.0, new THREE.Color(0.42,  0.56,  0.14)]
	],
	PLASMA: [
		[0.0 , new THREE.Color(0.5,  0.25,  0.5)],
		[0.25, new THREE.Color(0.0,  0.0,  0.56)],
		[0.5, new THREE.Color(0.28,  0.28,  0.28)],
		[0.75, new THREE.Color(0.60,  0.98, 0.60)],
		[1.0 , new THREE.Color(0.42,  0.56,  0.14)]
	],
	// PLASMA: [
	// 	[0.0, new THREE.Color(0.241, 0.015, 0.610)],
	// 	[0.1, new THREE.Color(0.387, 0.001, 0.654)],
	// 	[0.2, new THREE.Color(0.524, 0.025, 0.653)],
	// 	[0.3, new THREE.Color(0.651, 0.125, 0.596)],
	// 	[0.4, new THREE.Color(0.752, 0.227, 0.513)],
	// 	[0.5, new THREE.Color(0.837, 0.329, 0.431)],
	// 	[0.6, new THREE.Color(0.907, 0.435, 0.353)],
	// 	[0.7, new THREE.Color(0.963, 0.554, 0.272)],
	// 	[0.8, new THREE.Color(0.992, 0.681, 0.195)],
	// 	[0.9, new THREE.Color(0.987, 0.822, 0.144)],
	// 	[1.0, new THREE.Color(0.940, 0.975, 0.131)]
	// ],
	// YELLOW_GREEN: [
	// 	[0.000, new THREE.Color(0.5,  0.25,  0.5)],
	// 	[0.125, new THREE.Color(0.95,  0.14,  0.91)],
	// 	[0.250, new THREE.Color(0.86, 0.08, 0.24)],
	// 	[0.375, new THREE.Color(0.0,  0.0,  0.56)],
	// 	[0.500, new THREE.Color(0.28,  0.28,  0.28)],
	// 	[0.625, new THREE.Color(0.6,  0.6,  0.6)],
	// 	[0.750, new THREE.Color(0.60,  0.98, 0.60)],
	// 	[0.875, new THREE.Color(0.42,  0.56,  0.14)],
	// 	[1.000, new THREE.Color(1.00,  1.00,  1.00)]
	// ],
	CITYSCAPE: [
		[0.0000, new THREE.Color(0.5,  0.25,  0.5)],
		[0.0526, new THREE.Color(0.95,  0.14,  0.91)],
		[0.1053, new THREE.Color(70/255, 70/255, 70/255)],
		[0.1579, new THREE.Color(102/255, 102/255, 156/255)],
		[0.2105, new THREE.Color(190/255, 153/255, 153/255)],
		[0.2632, new THREE.Color(153/255, 153/255, 153/255)],
		[0.3158, new THREE.Color(250/255, 170/255, 30/255)],
		[0.3888, new THREE.Color(220/255, 220/255, 0)],
		[0.4235, new THREE.Color(107/255, 142/255, 35/255)],
		[0.4706, new THREE.Color(152/255, 251/255, 152/255)],
		[0.5263, new THREE.Color(70/255, 130/255, 180/255)],
		[0.6111, new THREE.Color(220/255, 20/255, 60/255)],
		[0.6316, new THREE.Color(255/255, 0, 0)],
		[0.6842, new THREE.Color(0, 0, 142/255)],
		[0.7353, new THREE.Color(0, 0, 70/255)],
		[0.7895, new THREE.Color(0, 60/255, 100/255)],
		[0.8421, new THREE.Color(0, 80/255, 100/255)],
		[0.8947, new THREE.Color(0, 0, 230/255)],
		[0.9474, new THREE.Color(119 / 255, 11 / 255, 32 / 255)],
		[1.0000, new THREE.Color(1, 1, 1)]
	],
	VIRIDIS: [
		[0.0, new THREE.Color(0.267, 0.005, 0.329)],
		[0.1, new THREE.Color(0.283, 0.141, 0.458)],
		[0.2, new THREE.Color(0.254, 0.265, 0.530)],
		[0.3, new THREE.Color(0.207, 0.372, 0.553)],
		[0.4, new THREE.Color(0.164, 0.471, 0.558)],
		[0.5, new THREE.Color(0.128, 0.567, 0.551)],
		[0.6, new THREE.Color(0.135, 0.659, 0.518)],
		[0.7, new THREE.Color(0.267, 0.749, 0.441)],
		[0.8, new THREE.Color(0.478, 0.821, 0.318)],
		[0.9, new THREE.Color(0.741, 0.873, 0.150)],
		[1.0, new THREE.Color(0.993, 0.906, 0.144)]
	],
	INFERNO: [
		[0.0, new THREE.Color(0.077, 0.042, 0.206)],
		[0.1, new THREE.Color(0.225, 0.036, 0.388)],
		[0.2, new THREE.Color(0.373, 0.074, 0.432)],
		[0.3, new THREE.Color(0.522, 0.128, 0.420)],
		[0.4, new THREE.Color(0.665, 0.182, 0.370)],
		[0.5, new THREE.Color(0.797, 0.255, 0.287)],
		[0.6, new THREE.Color(0.902, 0.364, 0.184)],
		[0.7, new THREE.Color(0.969, 0.516, 0.063)],
		[0.8, new THREE.Color(0.988, 0.683, 0.072)],
		[0.9, new THREE.Color(0.961, 0.859, 0.298)],
		[1.0, new THREE.Color(0.988, 0.998, 0.645)]
	],
	GRAYSCALE: [
		[0, new THREE.Color(0, 0, 0)],
		[1, new THREE.Color(1, 1, 1)]
	],
	// 16 samples of the TURBU color scheme
	// values taken from: https://gist.github.com/mikhailov-work/ee72ba4191942acecc03fe6da94fc73f
	// original file licensed under Apache-2.0
	TURBO: [
		[0.00, new THREE.Color(0.18995, 0.07176, 0.23217)],
		[0.07, new THREE.Color(0.25107, 0.25237, 0.63374)],
		[0.13, new THREE.Color(0.27628, 0.42118, 0.89123)],
		[0.20, new THREE.Color(0.25862, 0.57958, 0.99876)],
		[0.27, new THREE.Color(0.15844, 0.73551, 0.92305)],
		[0.33, new THREE.Color(0.09267, 0.86554, 0.7623)],
		[0.40, new THREE.Color(0.19659, 0.94901, 0.59466)],
		[0.47, new THREE.Color(0.42778, 0.99419, 0.38575)],
		[0.53, new THREE.Color(0.64362, 0.98999, 0.23356)],
		[0.60, new THREE.Color(0.80473, 0.92452, 0.20459)],
		[0.67, new THREE.Color(0.93301, 0.81236, 0.22667)],
		[0.73, new THREE.Color(0.99314, 0.67408, 0.20348)],
		[0.80, new THREE.Color(0.9836, 0.49291, 0.12849)],
		[0.87, new THREE.Color(0.92105, 0.31489, 0.05475)],
		[0.93, new THREE.Color(0.81608, 0.18462, 0.01809)],
		[1.00, new THREE.Color(0.66449, 0.08436, 0.00424)],
	],
	RAINBOW: [
		[0, new THREE.Color(0.278, 0, 0.714)],
		[1 / 6, new THREE.Color(0, 0, 1)],
		[2 / 6, new THREE.Color(0, 1, 1)],
		[3 / 6, new THREE.Color(0, 1, 0)],
		[4 / 6, new THREE.Color(1, 1, 0)],
		[5 / 6, new THREE.Color(1, 0.64, 0)],
		[1, new THREE.Color(1, 0, 0)]
	],
	CONTOUR: [
		[0.00, new THREE.Color(0, 0, 0)],
		[0.03, new THREE.Color(0, 0, 0)],
		[0.04, new THREE.Color(1, 1, 1)],
		[1.00, new THREE.Color(1, 1, 1)]
	],
};


export {Gradients};
