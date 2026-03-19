precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform sampler2D u_video;
uniform vec2 u_videoSize;
uniform float u_dotDensity;    
uniform float u_dotScale;      
uniform float u_contrast;      
uniform float u_showLines;     
uniform float u_invert;        

// Simple internal random functions to avoid #include errors
float random (vec2 st) {
    return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
}

vec2 random2(vec2 p) {
    return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453);
}

float sampleLuminance(vec2 uv) {
    float canvasAspect = u_resolution.x / u_resolution.y;
    float videoAspect = u_videoSize.x / u_videoSize.y;
    vec2 videoUV = uv;
    if (canvasAspect > videoAspect) {
        float scale = videoAspect / canvasAspect;
        videoUV.x = (uv.x - 0.5) / scale + 0.5;
    } else {
        float scale = canvasAspect / videoAspect;
        videoUV.y = (uv.y - 0.5) / scale + 0.5;
    }
    if (videoUV.x < 0.0 || videoUV.x > 1.0 || videoUV.y < 0.0 || videoUV.y > 1.0) return 0.5;
    videoUV.y = 1.0 - videoUV.y;
    vec3 color = texture2D(u_video, videoUV).rgb;
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    lum = (lum - 0.5) * u_contrast + 0.5;
    return clamp(lum, 0.0, 1.0);
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    float baseCellSize = 8.0 / u_dotDensity;
    
    // Background logic: Grey for normal, Dark for invert
    float bgGrey = (u_invert > 0.5) ? 0.1 : 0.5;
    vec3 finalColor = vec3(bgGrey);
    
    // Our Red Color Definition
    vec3 dotRed = vec3(1.0, 0.0, 0.0);

    for (int scale = 0; scale < 3; scale++) {
        float cellSize = baseCellSize / (1.0 + float(scale) * 0.5);
        float gridScale = u_resolution.y / cellSize;
        vec2 gridUV = uv * gridScale;
        vec2 cellID = floor(gridUV);

        for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
                vec2 neighborID = cellID + vec2(float(dx), float(dy));
                vec2 jitter = (random2(neighborID + float(scale) * 100.0) * 2.0 - 1.0) * 0.4;
                vec2 dotUV = (neighborID + vec2(0.5) + jitter) / gridScale;
                float lum = sampleLuminance(dotUV);
                float lumThreshold = float(scale) * 0.3;

                if (lum < (1.0 - lumThreshold) || scale == 0) {
                    float dotRadius = (u_invert > 0.5) ? mix(0.1, 0.45, lum) : mix(0.45, 0.1, lum);
                    dotRadius *= cellSize * u_dotScale;
                    if (dotRadius < 0.5) continue;

                    float dist = length(gl_FragCoord.xy - dotUV * u_resolution);
                    float dotDist = dist - dotRadius;
                    
                    if (dotDist < 1.0) {
                        float alpha = clamp(1.0 - dotDist, 0.0, 1.0);
                        // FORCE RED: We use dotRed regardless of u_invert
                        finalColor = mix(finalColor, dotRed, alpha);
                    }
                }
            }
        }
    }
    
    // Line Drawing Logic
    if (u_showLines > 0.5) {
        float lineRadius = baseCellSize * 2.5;
        vec2 pixelPos = gl_FragCoord.xy;
        float gridScale = u_resolution.y / baseCellSize;
        vec2 gridUV = uv * gridScale;
        vec2 cellID = floor(gridUV);

        for (int dy = -2; dy <= 2; dy++) {
            for (int dx = -2; dx <= 2; dx++) {
                vec2 neighborID1 = cellID + vec2(float(dx), float(dy));
                vec2 jitter1 = (random2(neighborID1) * 2.0 - 1.0) * 0.4;
                vec2 dot1UV = (neighborID1 + vec2(0.5) + jitter1) / gridScale;
                vec2 dot1Pos = dot1UV * u_resolution;

                for (int dy2 = -1; dy2 <= 1; dy2++) {
                    for (int dx2 = -1; dx2 <= 1; dx2++) {
                        if (dx2 == 0 && dy2 == 0) continue;
                        vec2 neighborID2 = neighborID1 + vec2(float(dx2), float(dy2));
                        vec2 jitter2 = (random2(neighborID2) * 2.0 - 1.0) * 0.4;
                        vec2 dot2UV = (neighborID2 + vec2(0.5) + jitter2) / gridScale;
                        vec2 dot2Pos = dot2UV * u_resolution;

                        if (length(dot1Pos - dot2Pos) < lineRadius) {
                            vec2 pa = pixelPos - dot1Pos;
                            vec2 ba = dot2Pos - dot1Pos;
                            float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
                            float lineDist = length(pa - ba * t);

                            if (lineDist < 0.5) {
                                float alpha = (1.0 - lineDist / 0.5) * 0.5;
                                if (sampleLuminance((dot1UV + dot2UV) * 0.5) < 0.5) {
                                    // FORCE RED LINES
                                    finalColor = mix(finalColor, dotRed, alpha);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    gl_FragColor = vec4(finalColor, 1.0);
}