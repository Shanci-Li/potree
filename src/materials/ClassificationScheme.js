
import * as THREE from "../../libs/three.js/build/three.module.js";

export const ClassificationScheme = {

	DEFAULT: {
		0:       { visible: true, name: 'never classified'  , color: [0.5,  0.5,  0.5,  1.0] },
		1:       { visible: true, name: 'unclassified'      , color: [0.5,  0.5,  0.5,  1.0] },
		2:       { visible: true, name: 'ground'            , color: [0.63, 0.32, 0.18, 1.0] },
		3:       { visible: true, name: 'low vegetation'    , color: [0.0,  1.0,  0.0,  1.0] },
		4:       { visible: true, name: 'medium vegetation' , color: [0.0,  0.8,  0.0,  1.0] },
		5:       { visible: true, name: 'high vegetation'   , color: [0.0,  0.6,  0.0,  1.0] },
		6:       { visible: true, name: 'building'          , color: [1.0,  0.66, 0.0,  1.0] },
		7:       { visible: true, name: 'low point(noise)'  , color: [1.0,  0.0,  1.0,  1.0] },
		8:       { visible: true, name: 'key-point'         , color: [1.0,  0.0,  0.0,  1.0] },
		9:       { visible: true, name: 'water'             , color: [0.0,  0.0,  1.0,  1.0] },
		12:      { visible: true, name: 'overlap'           , color: [1.0,  1.0,  0.0,  1.0] },
		DEFAULT: { visible: true, name: 'default'           , color: [0.3,  0.6,  0.6,  0.5] },
	},

	MAGIC3D: {
		0:       { visible: true, name: 'road'  			, color: [0.5,  0.25, 0.5,  1.0] },
		1:       { visible: true, name: 'sidewalk'    		, color: [0.95, 0.14, 0.91, 1.0] },
		2:       { visible: true, name: 'pedestrian'   	    , color: [0.86, 0.08, 0.24, 1.0] },
		3:       { visible: true, name: 'vehicle'    		, color: [0.0,  0.0,  0.56, 1.0] },
		4:       { visible: true, name: 'construction' 		, color: [0.28, 0.28, 0.28, 1.0] },
		5:       { visible: true, name: 'object'   			, color: [0.6,  0.6,  0.6,  1.0] },
		6:       { visible: true, name: 'terrain'          	, color: [0.60, 0.98, 0.60, 1.0] },
		7:       { visible: true, name: 'vegetation'  		, color: [0.42, 0.56, 0.14, 1.0] },
		DEFAULT: { visible: true, name: 'ignored'         	, color: [1.0,  1.0,  1.0,  1.0] },
	},

	AI3D: {
		0:       { visible: true, name: 'Pylône'  			, color: [0.5,	0.5,  0.5,  1.0] },
		1:       { visible: true, name: 'Conducteur'     	, color: [1.0, 	0.0,  1.0,  1.0] },
		2:       { visible: true, name: 'Câble_de_garde'	, color: [0.0, 	1.0,  1.0,  1.0] },
		3:       { visible: true, name: 'Cable de fixation' , color: [0.0,  0.0,  0.56, 1.0] },
		4:       { visible: true, name: 'Isolateur' 		, color: [0.0, 	1.0,  0.0,  1.0] },
		5:       { visible: true, name: 'Véget haute'   	, color: [0.42, 0.56, 0.14, 1.0] },
		6:       { visible: true, name: 'Veget basse'       , color: [0.60, 0.98, 0.60, 1.0] },
		7:       { visible: true, name: 'Sol'  				, color: [0.94, 0.94, 0.94, 1.0] },
		8:       { visible: true, name: 'Routes'         	, color: [0.6,  0.6,  0.6,  1.0] },
		9:       { visible: true, name: 'Eau'          		, color: [0.0,  0.0,  1.0,  1.0] },
		10:      { visible: true, name: 'Batiment'  		, color: [1.0, 	0.0,  0.0,  1.0] },
		11:      { visible: true, name: 'ignored'         	, color: [1.0,  1.0,  1.0,  1.0] },
	}
};

// // Magic3D project colormap
// export const ClassificationScheme = {

// 	DEFAULT: {
// 		0:       { visible: true, name: 'road'  , color: [0.5,  0.25,  0.5,  1.0] },
// 		1:       { visible: true, name: 'sidewalk'      , color: [0.95,  0.14,  0.91,  1.0] },
// 		2:       { visible: true, name: 'pedestrian'            , color: [0.86, 0.08, 0.24, 1.0] },
// 		3:       { visible: true, name: 'vehicle'    , color: [0.0,  0.0,  0.56,  1.0] },
// 		4:       { visible: true, name: 'construction' , color: [0.28,  0.28,  0.28,  1.0] },
// 		5:       { visible: true, name: 'object'   , color: [0.6,  0.6,  0.6,  1.0] },
// 		6:       { visible: true, name: 'terrain'          , color: [0.60,  0.98, 0.60,  1.0] },
// 		7:       { visible: true, name: 'vegetation'  , color: [0.42,  0.56,  0.14,  1.0] },
// 		8:       { visible: true, name: 'ignored'         , color: [1.0,  1.0,  1.0,  1.0] },
// 	}
// };

// // AutoInspect3D project colormap
// export const ClassificationScheme = {

// 	DEFAULT: {
// 		0:       { visible: true, name: 'Pylône'  , color: [0.5, 0.5, 0.5,  1.0] },
// 		1:       { visible: true, name: 'Conducteur'      , color: [1.0, 0.0, 1.0,  1.0] },
// 		2:       { visible: true, name: 'Câble_de_garde'            , color: [0.0, 1.0, 1.0, 1.0] },
// 		3:       { visible: true, name: 'Cable de fixation'    , color: [0.0,  0.0,  0.56,  1.0] },
// 		4:       { visible: true, name: 'Isolateur' , color: [0.0, 1.0, 0.0,  1.0] },
// 		5:       { visible: true, name: 'Véget haute'   , color: [0.42,  0.56,  0.14,  1.0] },
// 		6:       { visible: true, name: 'Veget basse'          , color: [0.60,  0.98, 0.60,  1.0] },
// 		7:       { visible: true, name: 'Sol'  , color: [0.94, 0.94, 0.94,  1.0] },
// 		8:       { visible: true, name: 'Routes'         , color: [0.6,  0.6,  0.6,  1.0] },
// 		9:       { visible: true, name: 'Eau'          , color: [0.0,  0.0, 1.0,  1.0] },
// 		10:      { visible: true, name: 'Batiment'  , color: [1.0, 0.0, 0.0,  1.0] },
// 		11:      { visible: true, name: 'ignored'         , color: [1.0,  1.0,  1.0,  1.0] },
// 	}
// };

Object.defineProperty(ClassificationScheme, 'RANDOM', {
	get: function() { 

		let scheme = {};

		for(let i = 0; i <= 255; i++){
			scheme[i] = new THREE.Vector4(Math.random(), Math.random(), Math.random());
		}

		scheme["DEFAULT"] = new THREE.Vector4(Math.random(), Math.random(), Math.random());

		return scheme;
	}
});
