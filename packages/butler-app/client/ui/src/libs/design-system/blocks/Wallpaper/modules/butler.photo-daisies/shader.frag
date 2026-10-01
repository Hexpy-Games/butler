// Living photo: daisy field (photo.jpg, 2000x1266). A filter over the engine's pre-fitted image
// (cover + blur by the engine; the engine's dim comes after).
//  - sunlight through leaves: two soft light-patch octaves circling in opposite directions 
//  - bokeh: bright out-of-focus discs brighten and fade gently, each on its own phase
//  - breeze: out-of-focus areas only sway a few px on a long, smooth wave (no local warping);
//    the in-focus band (lower left of this photo) stays pixel-exact
//  - same brightness in both themes (manifest imageDim "noDarkStep" -> the engine skips its dark dim step)
//  - headline: soft blur + adaptive veil behind the top of u_contentRect
// Loop: T = 120 s (patch orbits 1 and 2 per loop, bokeh 6 s x 20, sway 5 s x 24) -> seamless.
const float T = 120.0;
const float TAU = 6.2831853;
const vec3 LUMA = vec3(.2126, .7152, .0722);
const float PHOTO_ASPECT = 2000.0 / 1266.0;

float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return texture(u_noiseTexture, (i + f + .5) / 256.).r; }
vec3 img(vec2 fc) { return texture(u_image, fc / u_resolution).rgb; }

vec3 headlineVeil(vec3 col, vec2 fc, float strength) {
  float pr = max(u_pixelRatio, 1e-3);
  vec2 p = fc / pr, R = u_resolution / pr;
  vec4 cr = u_contentRect / pr;
  if (cr.z < 1. || cr.w < 1.) cr = vec4(R.x * .2, R.y * .42, R.x * .6, R.y * .5);
  float headH = min(cr.w * .45, max(150., cr.w * .36));
  vec2 hb = vec2(cr.z, headH) * .5, hc = vec2(cr.x, cr.y + cr.w - headH) + hb;
  vec2 q = abs(p - hc) - hb + 28.;
  float d = length(max(q, 0.)) + min(max(q.x, q.y), 0.) - 28.;
  float m = (1. - smoothstep(-40., 120., d)) * strength;
  if (m < .003) return col;
  float o = 5. * pr;
  vec3 b = (col + img(fc + vec2(o, o)) + img(fc + vec2(-o, o)) + img(fc + vec2(o, -o)) + img(fc - o)) * .2;
  float L = dot(b, LUMA);
  vec3 veil; float a;
  if (u_dark > .5) { veil = b * .3; a = clamp((L - .36) / max(L - dot(veil, LUMA), .05), 0., .5) + .08; }
  else { veil = 1. - (1. - b) * .22; a = clamp((.6 - L) / max(dot(veil, LUMA) - L, .05), 0., .5) + .08; }
  return mix(col, mix(mix(col, b, .7), veil, a), min(m, 1.));
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  if (u_hasImage < .5) { fragColor = vec4(mix(vec3(.93, .93, .9), vec3(.12, .13, .12), u_dark), 1.); return; }
  float pr = max(u_pixelRatio, 1e-3);
  vec2 p = fc / pr;                         // CSS px
  float t = u_time;
  float ang = TAU * t / T;

  // depth prior of this photo (photo uv, engine cover centred): in focus = lower-left band + bottom-right daisy
  float r = PHOTO_ASPECT / (u_resolution.x / u_resolution.y);
  vec2 disp = r < 1. ? vec2(1., 1. / r) : vec2(r, 1.);
  vec2 pu = (fc / u_resolution - .5) / disp + .5;
  float yTop = 1. - pu.y;
  float inFocus = smoothstep(.28, .5, yTop) * (1. - smoothstep(.62, .85, pu.x) * (1. - smoothstep(.7, .9, yTop)));
  float oof = 1. - inFocus;

  // breeze: a long travelling wave, gusting; amplitude 0 in the in-focus band
  float gust = .65 + .35 * sin(ang * 3. + 1.);
  float wave = dot(p, vec2(.0088, .0031)) - ang * 24. + vn(p / 380. + 17.) * 2.5;
  vec2 sway = vec2(sin(wave), .35 * sin(wave * .7 + 1.3)) * 3.6 * pr * gust * oof * p_wind;
  vec3 col = img(fc + sway);
  float lum = dot(col, LUMA);

  // sunlight through leaves: soft patches drifting (two octaves, opposite orbits)
  float n1 = vn(p / 95. + 3. * vec2(cos(ang), sin(ang)));
  float n2 = vn(p / 42. + 4. * vec2(cos(-ang * 2. + 2.), sin(-ang * 2. + 2.)) + 60.);
  float leaf = smoothstep(.36, .74, n1 * .62 + n2 * .38);
  float warmth = smoothstep(.15, .7, lum);
  float sun = (leaf - .4) * .16;
  col *= 1. + sun * (.35 + .65 * warmth) * p_sunlight;
  col += vec3(.035, .025, 0.) * leaf * warmth * p_sunlight;   // warm spill where the light falls

  // bokeh shimmer: bright out-of-focus discs breathe on their own phases
  float hl = smoothstep(.6, .9, lum) * (.25 + .75 * oof);
  float breath = sin(ang * 20. + vn(p / 38. + 200.) * TAU * 2.);
  col *= 1. + .085 * hl * breath * p_bokeh;

  // same photo brightness in both themes: no cooling here, and the manifest opts out of the engine's dark dim step
  col = headlineVeil(col, fc, p_veil);
  fragColor = vec4(clamp(col, 0., 1.), 1.);
}
