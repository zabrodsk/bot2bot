// The field's shaders. Every bot's state is a pure function of uniforms (route distance, ring
// radius, pokes), so scrubbing the story backwards is exact and costs nothing.
// Units: a bot is drawn in "bot units" (head 16 × 13, as in the brand mark); uScale maps them to
// world units. Pixel size is computed analytically (no derivatives extension needed).

export const botVertex = /* glsl */ `
precision highp float;
attribute vec2 position;
attribute vec2 aPos;
attribute vec2 aData;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
uniform float uTime;
uniform float uScale;
uniform float uViewH;
uniform float uBoot;
uniform vec2 uYou;
uniform float uYouAmt;
uniform float uYouWake;
uniform float uYouLight;
uniform vec2 uAnna;
uniform float uAnnaWake;
uniform float uSigD;
uniform float uRepD;
uniform float uRouteLen;
uniform float uPathAmt;
uniform vec3 uWave;
uniform float uWaveAmt;
uniform float uWaveTail;
uniform float uDream;
uniform float uAlive;
uniform float uQuiet;
uniform float uHush;
uniform vec4 uPair;
uniform float uPairAmt;
uniform vec2 uHouse[6];
uniform float uHouseAmt;
uniform vec3 uMissing;
uniform vec4 uPokes[12];
uniform vec4 uRipples[4];
uniform vec3 uMouse;
uniform vec2 uFog;
uniform vec2 uField;
varying vec2 vUv;
varying float vWake;
varying float vEye;
varying float vYou;
varying float vLight;
varying float vAlpha;
varying float vLook;
varying float vGhost;
varying float vPx;

float hash(float n) { return fract(sin(n) * 43758.5453123); }
float near(vec2 a, vec2 b) { return 1.0 - step(0.1, distance(a, b)); }

void main() {
  float seed = aData.x;
  float pathD = aData.y;
  vec2 p = aPos;
  float wake = 0.0;

  // The signal and the street it lights.
  if (pathD >= 0.0) {
    float ahead = uSigD - pathD;
    float pulse = exp(-ahead * ahead * 0.2);
    float rest = smoothstep(0.0, 3.0, ahead) * 0.3;
    float back = uRepD - (uRouteLen - pathD);
    float rpulse = step(0.001, uRepD) * exp(-back * back * 0.2);
    wake = max(wake, max(max(pulse, rest), rpulse) * uPathAmt);
  }

  // The ring: a band of awake bots rolling outward, a faint hum left behind.
  float dw = distance(p, uWave.xy);
  float R = uWave.z;
  float band = smoothstep(R - uWaveTail, R - uWaveTail * 0.12, dw) * (1.0 - smoothstep(R - 0.3, R + 1.0, dw));
  float hum = (1.0 - smoothstep(R - 1.5, R, dw)) * 0.07;
  wake = max(wake, (band + hum) * uWaveAmt * step(0.01, R));

  // Ambient: a few bots dream, their lights come on and go off on their own.
  float rate = 0.09 + seed * 0.06;
  float ph = uTime * rate + seed * 91.0;
  float pick = hash(floor(ph) * 13.7 + seed * 1000.0);
  float f = fract(ph);
  float dream = step(1.0 - uDream, pick) * smoothstep(0.0, 0.08, f) * (1.0 - smoothstep(0.35, 0.9, f));
  wake = max(wake, dream * 0.85);

  // Finale: the field is alive.
  float alive = step(1.0 - uAlive * 0.38, hash(seed * 733.0 + 3.1));
  float tw = 0.72 + 0.28 * sin(uTime * (1.2 + seed * 2.0) + seed * 40.0);
  wake = max(wake, alive * tw);

  // Pointer: bots near it stir. Taps ring a small ring.
  float stir = 0.0;
  for (int i = 0; i < 12; i++) {
    vec4 k = uPokes[i];
    float a = clamp(1.0 - (uTime - k.z) / 2.2, 0.0, 1.0);
    stir = max(stir, a * a * k.w * (1.0 - smoothstep(0.8, 3.6, distance(p, k.xy))));
  }
  for (int i = 0; i < 4; i++) {
    vec4 k = uRipples[i];
    float age = uTime - k.z;
    float rr = age * 10.0;
    float ring = (1.0 - smoothstep(0.0, 3.0, abs(distance(p, k.xy) - rr + 1.5))) * clamp(1.0 - age / 2.2, 0.0, 1.0);
    stir = max(stir, ring * k.w * step(0.0, age));
  }
  wake = max(wake, stir * 0.9);

  // Facts: two bots that both said yes, a household of six.
  wake = max(wake, min(near(p, uPair.xy) + near(p, uPair.zw), 1.0) * uPairAmt);
  float house = 0.0;
  for (int i = 0; i < 6; i++) house += near(p, uHouse[i]);
  wake = max(wake, min(house, 1.0) * uHouseAmt);

  // Quiet hours: nobody gets woken, not even by you.
  wake *= 1.0 - uQuiet * 0.94;

  wake = max(wake, near(p, uAnna) * uAnnaWake);
  float isYouRaw = near(p, uYou);
  float isYou = isYouRaw * uYouAmt;
  vLight = clamp(max(wake, isYouRaw * uYouLight), 0.0, 1.0);
  wake = max(wake, isYou * uYouWake);
  wake = clamp(wake, 0.0, 1.0);

  float blink = step(0.986, fract(uTime * 0.21 + seed * 17.0));
  vEye = smoothstep(0.2, 0.75, wake) * (1.0 - blink);
  vWake = wake;
  vYou = isYou;
  vGhost = near(p, uMissing.xy) * uMissing.z;

  // Eyes glance toward the pointer.
  float md = distance(p, uMouse.xy);
  vLook = clamp((uMouse.x - p.x) * 0.35, -1.0, 1.0) * uMouse.z * (1.0 - smoothstep(1.5, 6.0, md)) * 1.1;

  // Boot: the field appears in a ring from your bot.
  float appear = 1.0 - smoothstep(uBoot * 160.0 - 8.0, uBoot * 160.0, distance(p, uYou));

  float s = uScale * (1.0 + 0.08 * wake + 0.16 * isYou) * mix(0.3, 1.0, appear);
  vec3 center = vec3(p.x, 0.2, p.y);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wpos = center + (right * position.x + up * position.y) * s;
  vec4 mv = viewMatrix * vec4(wpos, 1.0);
  gl_Position = projectionMatrix * mv;

  float depth = max(0.05, -mv.z);
  vPx = s * projectionMatrix[1][1] * 0.5 * uViewH / depth;
  vUv = position;

  float dist = distance(cameraPosition, center);
  float fog = smoothstep(uFog.x, uFog.y, dist);
  float edge = (1.0 - smoothstep(uField.x - 16.0, uField.x, abs(p.x))) * smoothstep(uField.y, uField.y + 18.0, p.y);
  float close = smoothstep(0.7, 2.2, dist);
  // Depth of field, by brightness: the nearest rows sit back so the eye goes to the middle.
  float nearDim = mix(0.42, 1.0, smoothstep(3.5, 13.0, dist));
  nearDim = max(nearDim, max(isYou, wake));
  vAlpha = (1.0 - fog) * edge * close * appear * nearDim;
  // Hush: the crowd steps back, only the highlighted bots stay ("only the two bots").
  float keep = max(isYou, max(min(near(p, uPair.xy) + near(p, uPair.zw), 1.0) * uPairAmt, min(house, 1.0) * uHouseAmt));
  vAlpha *= mix(1.0, 0.14, uHush * (1.0 - keep));
}
`;

export const botFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying float vWake;
varying float vEye;
varying float vYou;
varying float vLight;
varying float vAlpha;
varying float vLook;
varying float vGhost;
varying float vPx;
uniform vec3 uGround;
uniform vec3 uBody;
uniform vec3 uBodyAwake;
uniform vec3 uSleep;
uniform vec3 uAwake;
uniform vec3 uBlue;
uniform vec3 uBlueHot;

float sdRR(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
vec4 over(vec4 d, vec3 c, float a) { return vec4(c * a + d.rgb * (1.0 - a), a + d.a * (1.0 - a)); }

void main() {
  if (vAlpha < 0.004) discard;
  float w = 1.0 / max(vPx, 0.02);
  vec2 p = vUv;
  float wake = vWake;
  float you = vYou;

  float head = sdRR(p, vec2(8.0, 6.5), 4.0);
  float fill = clamp(0.5 - head / w, 0.0, 1.0);
  float sw = max(1.35, w * 1.05);
  float ring = clamp(0.5 - (abs(head + sw * 0.5) - sw * 0.5) / w, 0.0, 1.0);

  float eh = mix(0.55, 1.85, vEye);
  vec2 ep = vec2(abs(p.x - vLook) - 3.1, p.y - 0.2);
  float eye = sdRR(ep, vec2(1.5, eh), min(1.0, eh));
  float eyeA = clamp(0.5 - eye / w, 0.0, 1.0) * fill;

  float ant = sdSeg(p, vec2(0.0, 6.5), vec2(0.0, 9.6)) - max(0.62, w * 0.5);
  float antA = clamp(0.5 - ant / w, 0.0, 1.0);
  float ld = length(p - vec2(0.0, 11.3));
  float lightA = clamp(0.5 - (ld - 1.9) / w, 0.0, 1.0);

  vec3 line = mix(uSleep, uAwake, wake);
  vec3 body = mix(uBody, uBodyAwake, wake);
  vec3 eyeC = line;
  body = mix(body, uAwake, you);
  line = mix(line, uAwake, you);
  eyeC = mix(eyeC, uGround, you);
  float lit = vLight;
  vec3 lightC = mix(uSleep, uBlueHot, smoothstep(0.08, 0.55, lit));

  vec4 c = over(vec4(0.0), body, fill);
  c = over(c, line, ring);
  c = over(c, eyeC, eyeA);
  c = over(c, line, antA);
  c = over(c, lightC, lightA);

  // A missing bot: only a faint dashed outline where it should be.
  float ang = atan(p.y, p.x);
  float dash = step(0.45, fract(ang * 3.0));
  float gring = clamp(0.5 - (abs(head + 1.0) - 1.0) / w, 0.0, 1.0);
  vec4 ghost = over(vec4(0.0), mix(uSleep, uAwake, 0.55), gring * dash);
  c = mix(c, ghost, vGhost);

  // Light: a blue halo around the status light, a faint rim around awake heads.
  float far = 1.0 + 1.4 * (1.0 - smoothstep(0.25, 1.2, vPx));
  float edge = min(12.0 - abs(p.x), min(p.y + 10.0, 22.0 - p.y));
  float keep = smoothstep(0.0, 4.0, edge);
  float halo = exp(-ld * ld / ((12.0 + 18.0 * lit) * far)) * lit * (1.0 - vGhost);
  float rim = exp(-max(head, 0.0) / 1.5) * (1.0 - fill) * wake * 0.16 * (1.0 - vGhost);
  c.rgb += uBlue * (halo * (0.8 + 0.45 * far) + rim) * keep;

  gl_FragColor = c * vAlpha;
}
`;

export const routeVertex = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 aInfo;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
uniform vec2 uFog;
varying float vD;
varying float vSide;
varying float vFog;
void main() {
  vD = aInfo.x;
  vSide = aInfo.y;
  vFog = smoothstep(uFog.x, uFog.y, distance(cameraPosition, position));
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

export const routeFragment = /* glsl */ `
precision highp float;
varying float vD;
varying float vSide;
varying float vFog;
uniform float uSigD;
uniform float uRepD;
uniform float uRouteLen;
uniform float uPathAmt;
uniform vec3 uBlue;
uniform vec3 uBlueHot;
void main() {
  float v = abs(vSide);
  float core = 1.0 - smoothstep(0.1, 0.24, v);
  float glow = exp(-v * v * 5.0);
  float drawn = 1.0 - smoothstep(uSigD - 0.05, uSigD, vD);
  float head = exp(-pow((uSigD - vD) * 0.3, 2.0)) * drawn;
  float fromEnd = uRouteLen - vD;
  float rdrawn = step(0.001, uRepD) * (1.0 - smoothstep(uRepD - 0.05, uRepD, fromEnd));
  float rhead = exp(-pow((uRepD - fromEnd) * 0.3, 2.0)) * rdrawn;
  float I = drawn * 0.5 + head * 1.3 + rhead * 1.4 + rdrawn * 0.25;
  vec3 col = uBlue * (core * 0.85 + glow * 0.4) * I + uBlueHot * core * (head + rhead) * 0.7;
  gl_FragColor = vec4(col * uPathAmt * (1.0 - vFog), 0.0);
}
`;

export const cometVertex = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute float aSize;
attribute float aGlow;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uViewH;
uniform float uAmt;
varying float vGlow;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = aSize * projectionMatrix[1][1] * 0.5 * uViewH / max(0.1, -mv.z);
  gl_PointSize = clamp(px, 2.0, 160.0);
  vGlow = aGlow * uAmt;
}
`;

export const cometFragment = /* glsl */ `
precision highp float;
varying float vGlow;
uniform vec3 uBlue;
uniform vec3 uBlueHot;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d = length(q) * 2.0;
  float soft = exp(-d * d * 4.5);
  float core = exp(-d * d * 38.0);
  vec3 col = uBlue * soft * 0.9 + uBlueHot * core;
  gl_FragColor = vec4(col * vGlow, 0.0);
}
`;
