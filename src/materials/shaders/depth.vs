precision highp float;
precision highp int;

#define PI 3.141592653589793

attribute vec3 position;
attribute vec3 normal;
attribute vec3 color;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;

uniform float uScreenWidth;
uniform float uScreenHeight;
uniform float near;
uniform float far;

uniform float size;
uniform float minSize;
uniform float maxSize;

varying vec3 vViewPosition;
varying float vRadius;

void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vec4 viewPosition = viewMatrix * worldPosition;
    vViewPosition = viewPosition.xyz;
    
    vec4 projectedPosition = projectionMatrix * viewPosition;
    gl_Position = projectedPosition;
    
    // Calculate point size based on camera distance
    float projFactor = 1.0 / tan(PI / 8.0);
    projFactor = projFactor / projectedPosition.w;
    float r = size * 0.5;
    vRadius = r;
    
    // Apply size limits
    float projectedSize = max(minSize, min(maxSize, r * projFactor));
    gl_PointSize = projectedSize;
} 