precision highp float;
precision highp int;

#if defined paraboloid_point_shape
	#extension GL_EXT_frag_depth : enable
#endif

uniform mat4 viewMatrix;
uniform mat4 uViewInv;
uniform mat4 uProjInv;
uniform vec3 cameraPosition;
uniform float near;
uniform float far;

uniform mat4 projectionMatrix;
uniform float uOpacity;

varying vec3 vViewPosition;
varying float vRadius;

void main() {
    // Calculate linear depth (distance from camera)
    float linearDepth = -vViewPosition.z;
    float normalizedDepth = clamp((linearDepth - near) / max(far - near, 0.000001), 0.0, 1.0);
    
    // Store inverse depth in all RGB channels for visualization
    // You can also use a single channel for the actual depth data
    gl_FragColor = vec4(vec3(1.0 - normalizedDepth), 1.0);
    
    #if defined(circle_point_shape) || defined(paraboloid_point_shape) 
        float u = 2.0 * gl_PointCoord.x - 1.0;
        float v = 2.0 * gl_PointCoord.y - 1.0;
    #endif
    
    #if defined(circle_point_shape) 
        float cc = u*u + v*v;
        if(cc > 1.0){
            discard;
        }
    #endif
    
    #if defined paraboloid_point_shape
        float wi = 0.0 - ( u*u + v*v);
        vec4 pos = vec4(vViewPosition, 1.0);
        pos.z += wi * vRadius;
        linearDepth = -pos.z;
        pos = projectionMatrix * pos;
        pos = pos / pos.w;
        float expDepth = pos.z;
        float depth = (pos.z + 1.0) / 2.0;
        gl_FragDepthEXT = depth;
        
        // Normalize updated depth
        normalizedDepth = clamp((linearDepth - near) / max(far - near, 0.000001), 0.0, 1.0);
        gl_FragColor = vec4(vec3(1.0 - normalizedDepth), 1.0);
    #endif
} 