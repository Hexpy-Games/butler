// Living photo: sunset cumulus (photo.jpg, 2000x1334). A filter over the engine's pre-fitted image
// (cover + blur by the engine; the engine's dim comes after).
//  - clouds billow: two-phase flow-map UV displacement (divergent noise field + slow rightward drift),
//    confined to cloud pixels (warm/grey vs blue sky); phases offset per region so no global pulse
//  - light: a soft glow drifts over the cloud faces and the white balance warms/cools over the loop
//  - the bird: its own pixels are keyed off the photo and re-drawn flying a long loop over the open sky:
//    glides, banking turns (seen edge-on, tilted), speed changes, bursts of flapping; its original spot
//    is cloned over from the cloud beside it and never displaced
//  - same brightness in both themes (manifest imageDim "noDarkStep" -> the engine skips its dark dim step)
//  - headline: soft blur + adaptive veil behind the top of u_contentRect
// Loop: T = 120 s (flow phase 8 s x 15, 1 bird lap, light 1-2 cycles) -> seamless.
const float T = 120.0;
const float TAU = 6.2831853;
const vec3 LUMA = vec3(.2126, .7152, .0722);
const float PHOTO_W = 2000.0;
const float PHOTO_ASPECT = 2000.0 / 1334.0;
const vec2 BIRD = vec2(1006.0 / 2000.0, 1.0 - 674.0 / 1334.0);   // photo uv, bottom-left origin
const vec3 BIRD_COL = vec3(.085, .035, .035);

float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return texture(u_noiseTexture, (i + f + .5) / 256.).r; }
vec2 vn2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return texture(u_noiseTexture, (i + f + .5) / 256.).gb; }
vec3 img(vec2 fc) { return texture(u_image, fc / u_resolution).rgb; }   // canvas px -> pre-fitted image

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
  if (u_hasImage < .5) { fragColor = vec4(mix(vec3(.93, .9, .88), vec3(.12, .12, .14), u_dark), 1.); return; }
  float pr = max(u_pixelRatio, 1e-3);
  vec2 p = fc / pr;                         // CSS px
  float t = u_time;
  float ang = TAU * t / T;

  // photo placement (engine cover, centred) — only the bird needs it
  float r = PHOTO_ASPECT / (u_resolution.x / u_resolution.y);
  vec2 disp = r < 1. ? vec2(1., 1. / r) : vec2(r, 1.);
  float s = disp.x * u_resolution.x / PHOTO_W;          // canvas px per photo px
  vec2 bo = ((BIRD - .5) * disp + .5) * u_resolution;  // original bird, canvas px

  // cloud mask from a small undisplaced neighbourhood: warm/grey clouds vs saturated blue sky
  vec3 c0 = img(fc);
  vec3 cm = (c0 * 2. + img(fc + vec2(9., 5.) * pr) + img(fc - vec2(5., 9.) * pr)) * .25;
  float cloud = smoothstep(-.22, -.05, cm.r - cm.b);
  float keep = smoothstep(16., 42., length((fc - bo) / s));  // never drag the bird's pixels

  // two-phase flow map: divergent noise field (billowing) + slow drift to the right
  vec2 evo = 2.2 * vec2(cos(ang), sin(ang));
  vec2 F = (vn2(p / 170. + evo) - .5) * 2.6 + vec2(.55, .08);
  float P = 8.;
  float ph = fract(t / P + vn(p / 320. + 40.));
  float ph2 = fract(ph + .5);
  vec2 amp = F * 17. * pr * p_billow * cloud * keep;
  vec3 a0 = img(fc - amp * (ph - .5));
  vec3 a1 = img(fc - amp * (ph2 - .5));
  vec3 col = mix(a0, a1, abs(ph - .5) * 2.);

  // light: a soft glow drifting over lit cloud faces + white balance warming/cooling over the loop
  float lum = dot(col, LUMA);
  float glow = vn(p / 260. + 1.6 * vec2(cos(ang * 2.), sin(ang * 2.)) + 90.) - .5;
  float lit = cloud * smoothstep(.25, .75, lum);
  col *= 1. + .16 * glow * lit * p_light;
  float warm = sin(ang + 1.2);
  col *= mix(vec3(1.), mix(vec3(.975, .995, 1.03), vec3(1.035, 1.0, .955), .5 + .5 * warm), lit * p_light);

  // the bird: clone its original spot away, re-draw its own pixels along a slow soaring ellipse
  if (p_bird > .5) {
    vec2 d0 = (fc - bo) / s;
    float hole = (1. - smoothstep(6., 10., abs(d0.x))) * (1. - smoothstep(5., 8.5, abs(d0.y)));
    if (hole > 0.) col = mix(col, (img(fc + vec2(-16., 0.) * s) + img(fc + vec2(-12., -12.) * s)) * .5, hole);
    // flight: one lap a loop over the open sky below the cloud line, kept inside the visible crop.
    // th warps time: slow through the banking turns (ellipse ends), fast on the straights.
    float lo = (.5 - .5 / disp.x) * PHOTO_W, hi = (.5 + .5 / disp.x) * PHOTO_W;
    float ax = min(380., (hi - lo) * .42);
    float cx = clamp(1330., lo + ax + 20., hi - ax - 20.);
    float env = 0.;                                        // bursts of flapping, mostly after the turns
    for (int k = 0; k < 4; k++) {
      vec2 b = k == 0 ? vec2(4.5, 1.5) : k == 1 ? vec2(33., .8) : k == 2 ? vec2(64.5, 1.7) : vec2(91., .9);
      float dt = t - b.x;
      env += smoothstep(0., .12, dt) * (1. - smoothstep(b.y - .2, b.y, dt));
    }
    vec2 P0, P1;
    for (int k = 0; k < 2; k++) {
      float u = (t + float(k) * .25) / T;
      float th = TAU * u + .3 * sin(TAU * u * 2. + 3.14159);
      vec2 P = vec2(cx - ax * cos(th) + 35. * cos(2. * th), 860. - 115. * sin(th) + 30. * sin(2. * th + .7));
      P.y += 5. * sin(ang * 17.) - 4. * env;                // glide undulation, a little lift while flapping
      if (k == 0) P0 = P; else P1 = P;
    }
    vec2 v = P1 - P0;                                      // photo px per .25 s, y down
    float fwd = abs(v.x) / max(length(v), 1e-3);           // 0 = heading into/out of the frame (banking)
    float sx = sign(v.x + 1e-4) * mix(.28, 1., smoothstep(0., .6, fwd));
    float tilt = clamp(atan(-v.y, abs(v.x)) * .7, -.45, .45) * sign(v.x + 1e-4) * smoothstep(0., .5, fwd);
    float depth = 1. - .12 * (860. - P0.y) / 115.;         // far side of the loop a touch smaller
    float sy = 1. - .6 * env * (.5 + .5 * sin(TAU * 4.5 * t));
    vec2 pos = ((vec2(P0.x / PHOTO_W, 1. - P0.y / (PHOTO_W / PHOTO_ASPECT)) - .5) * disp + .5) * u_resolution;
    vec2 dl = (fc - pos) / s;
    float cs = cos(tilt), sn = sin(tilt);
    vec2 lb = mat2(cs, -sn, sn, cs) * dl / (vec2(sx, sy) * depth);
    if (abs(lb.x) < 9. && abs(lb.y) < 7.) {
      vec2 src = bo + lb * s;
      vec3 sc = img(src);
      vec3 bg = (img(src + vec2(-16., 0.) * s) + img(src + vec2(-12., -12.) * s)) * .5;
      float Lb = dot(bg, LUMA);
      float al = smoothstep(.35, .85, (Lb - dot(sc, LUMA)) / max(Lb - .04, .05));
      al *= (1. - smoothstep(7., 9., abs(lb.x))) * (1. - smoothstep(5., 7., abs(lb.y)));
      col = mix(col, BIRD_COL, al);
    }
  }

  // same photo brightness in both themes: no cooling here, and the manifest opts out of the engine's dark dim step
  col = headlineVeil(col, fc, p_veil);
  fragColor = vec4(clamp(col, 0., 1.), 1.);
}
