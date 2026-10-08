import * as THREE from "../../libs/three.js/build/three.module.js";
import {Utils} from "../utils.js";
import {Shaders} from "../../build/shaders/shaders.js";
import {PointSizeType, PointShape, TreeType} from "../defines.js";

export class DepthMaterial extends THREE.RawShaderMaterial {
    constructor(parameters = {}) {
        super();
        
        this.visibleNodesTexture = Utils.generateDataTexture(2048, 1, new THREE.Color(0xffffff));
        this.visibleNodesTexture.minFilter = THREE.NearestFilter;
        this.visibleNodesTexture.magFilter = THREE.NearestFilter;
        
        let getValid = (a, b) => {
            if(a !== undefined){
                return a;
            }else{
                return b;
            }
        }
        
        let pointSize = getValid(parameters.size, 1.0);
        let minSize = getValid(parameters.minSize, 2.0);
        let maxSize = getValid(parameters.maxSize, 50.0);
        
        this._pointSizeType = PointSizeType.FIXED;
        this._shape = PointShape.SQUARE;
        this.lights = false;
        this.fog = false;
        
        this.uniforms = {
            level:              { type: "f", value: 0.0 },
            vnStart:            { type: "f", value: 0.0 },
            spacing:            { type: "f", value: 1.0 },
            fov:                { type: "f", value: 1.0 },
            screenWidth:        { type: "f", value: 1.0 },
            screenHeight:       { type: "f", value: 1.0 },
            near:               { type: "f", value: 0.1 },
            far:                { type: "f", value: 1.0 },
            uOpacity:           { type: "f", value: 1.0 },
            size:               { type: "f", value: pointSize },
            minSize:            { type: "f", value: minSize },
            maxSize:            { type: "f", value: maxSize },
            octreeSize:         { type: "f", value: 0 },
            visibleNodes:       { type: "t", value: this.visibleNodesTexture },
            pcIndex:            { type: "f", value: 0 },
            useOrthographicCamera: { type: "b", value: false },
        };
        
        this.vertexShader = this.getDefines() + '\n' + this.getVertexShader();
        this.fragmentShader = this.getDefines() + '\n' + this.getFragmentShader();
        
        this.attributes = {
            position: { type: 'fv', value: [] },
            normal: { type: 'fv', value: [] },
            color: { type: 'fv', value: [] },
        };
    }
    
    getDefines() {
        let defines = "";
        
        if(this._pointSizeType === PointSizeType.FIXED) {
            defines += "#define fixed_point_size\n";
        } else if(this._pointSizeType === PointSizeType.ATTENUATED) {
            defines += "#define attenuated_point_size\n";
        } else if(this._pointSizeType === PointSizeType.ADAPTIVE) {
            defines += "#define adaptive_point_size\n";
        }
        
        if(this._shape === PointShape.SQUARE) {
            defines += "#define square_point_shape\n";
        } else if(this._shape === PointShape.CIRCLE) {
            defines += "#define circle_point_shape\n";
        } else if(this._shape === PointShape.PARABOLOID) {
            defines += "#define paraboloid_point_shape\n";
        }
        
        return defines;
    }
    
    getVertexShader() {
        return Shaders['depth.vs'];
    }
    
    getFragmentShader() {
        return Shaders['depth.fs'];
    }
    
    updateShaderSource() {
        this.vertexShader = this.getDefines() + '\n' + this.getVertexShader();
        this.fragmentShader = this.getDefines() + '\n' + this.getFragmentShader();
        
        if (this.needsUpdate) {
            this.needsUpdate = true;
        }
    }
    
    get pointSizeType() {
        return this._pointSizeType;
    }
    
    set pointSizeType(value) {
        if (this._pointSizeType !== value) {
            this._pointSizeType = value;
            this.updateShaderSource();
        }
    }
    
    get shape() {
        return this._shape;
    }
    
    set shape(value) {
        if (this._shape !== value) {
            this._shape = value;
            this.updateShaderSource();
        }
    }
    
    get size() {
        return this.uniforms.size.value;
    }
    
    set size(value) {
        if (this.uniforms.size.value !== value) {
            this.uniforms.size.value = value;
        }
    }
    
    get minSize() {
        return this.uniforms.minSize.value;
    }
    
    set minSize(value) {
        if (this.uniforms.minSize.value !== value) {
            this.uniforms.minSize.value = value;
        }
    }
    
    get maxSize() {
        return this.uniforms.maxSize.value;
    }
    
    set maxSize(value) {
        if (this.uniforms.maxSize.value !== value) {
            this.uniforms.maxSize.value = value;
        }
    }
    
    get near() {
        return this.uniforms.near.value;
    }
    
    set near(value) {
        if (this.uniforms.near.value !== value) {
            this.uniforms.near.value = value;
        }
    }
    
    get far() {
        return this.uniforms.far.value;
    }
    
    set far(value) {
        if (this.uniforms.far.value !== value) {
            this.uniforms.far.value = value;
        }
    }
} 