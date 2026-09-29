// butler.diatom — per-frame overlay (two-pass module form, engine prototype)
//
// u_base holds shader.frag's static valve, rendered once per input change. This pass runs every
// frame and adds only what moves, all of it in the mountant, never on the valve's own detail:
//   debris   the same sparse particles as before (denser along the rim), now creeping with the
//            mountant: a slow Lissajous drift of <= ~10 px (faster for particles higher in the
//            mount) plus a tiny per-particle wobble, ~0.1-0.4 px/s
//   shards   three loose silica chips beside the valve (areolae + a costa, same optics), drifting
//            and turning very slowly
//   grain    a fresh fine film-grain field every frame, strongest in the mid-tones (param `grain`)
// Everything composites onto the base the way the single-pass shader combined it: brightfield
// multiplies transmission, darkfield adds scatter before the film shoulder (exact on the tone-mapped
// base), DIC adds optical path to the shear relief. Loop: every periodic term divides T_PERIOD
// (= wallpaper.json timePeriod).
// Cost at 1440x900: ~0.44 ms per frame (the static base, ~1.2 ms, only on an input change).
// No loops around branches here: under ANGLE/Metal a 3-iteration loop around the shard test cost
// ~0.4 ms more than three explicit calls.

#define TAU 6.28318530718
const float T_PERIOD = 240.;

float gAA, gDof, gK;

float fsin(float x) {
  x *= .15915494; x -= floor(x + .5);
  float y = x * (8. - 16. * abs(x));
  return .225 * (y * abs(y) - y) + y;
}
float fcos(float x) { return fsin(x + 1.5707963); }
float sq(float x) { return x * x; }
float sat(float x) { return clamp(x, 0., 1.); }
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
mat2 rot(float a) { float c = fcos(a), s = fsin(a); return mat2(c, s, -s, c); }
float sdRoundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
float tri(float x) { return abs(fract(x) - .5); }
uint lb32(uint x) { x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }

vec2 hexNearest(vec2 p) {
  const vec2 s = vec2(1., 1.7320508);
  vec4 hc = floor(vec4(p, p - vec2(.5, 1.)) / s.xyxy) + .5;
  vec4 h = vec4(p - hc.xy * s, p - (hc.zw + .5) * s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? h.xy : h.zw;
}

// accumulated effect of the moving layer: transmission (BF), scatter (DF), optical path (DIC)
vec3 aT = vec3(1.); float aG = 0., aH = 0.;

// one loose silica chip: irregular pentagon, areola halftone + one costa, focus-dependent contrast
void shard(vec2 p, vec2 c, float size, float ang, float depth, float focus, float pitch, float hs) {
  vec2 u = rot(-ang) * (p - c);                          // (the caller did the bounding test)
  // convex pentagon, stretched into a sliver: max of the edge half-planes (exact inside, close enough outside)
  float el = 1.25 + .6 * hs;
  vec2 uq = vec2(u.x / el, u.y);
  float dP = -1e3;
  vec2 v0 = vec2(0.);
  for (int k = 0; k < 6; k++) {
    float kk = float(k % 5);                              // vertex 5 closes onto vertex 0
    float a = (float(k) + .6 * (hash11(hs * 7.1 + kk) - .5)) * TAU / 5.;
    float rr = size * (.5 + .6 * hash11(hs * 3.3 + kk * 1.7));
    vec2 v = rr * vec2(fcos(a), fsin(a));
    if (k > 0) { vec2 n = normalize(vec2(v.y - v0.y, v0.x - v.x)); dP = max(dP, dot(uq - v0, n)); }
    v0 = v;
  }
  dP += .9 * tri(dot(u, vec2(.37, .93)) * .21 + hs);   // fracture edges are not quite straight
  float zs = (focus - depth) * gDof;
  float sc = pitch / 15.;
  float C = fcos(1.35 * zs) * exp(-.1 * zs * zs), B = fsin(1.35 * zs) * exp(-.22 * zs * zs);
  float blurP = pitch * (.06 + .14 * abs(zs)), attP = exp(-2.2 * sq(blurP / pitch));
  float blurE = (.5 + 2.4 * abs(zs)) * sc;
  float e = -dP;                                          // px inside the silica
  float inV = smoothstep(-gAA - .5 * blurE, gAA + .5 * blurE, e);
  // areolae (hex, same pitch as the valve) and one costa crossing the chip
  vec2 h = hexNearest(u / pitch + hs * 9.) * pitch;
  float rp = .34 * pitch, se = min(blurP, .55 * rp) + gAA;
  float dA = length(h);
  float pm = 1. - smoothstep(rp - se, rp + se, dA);
  float ring = exp(-sq((dA - rp) / (.28 * rp + se)));
  float hw = .27 * pitch, blurC = (.4 + 1.5 * abs(zs + .75 * gDof)) * sc;
  float costa = smoothstep(blurC + gAA, -blurC - gAA, abs(u.y - size * (hs - .5) * .6) - hw) * hw / (hw + .6 * blurC);
  float Tin = .6 + .8 * gK * attP * C * (pm - .38) + .1 * attP * B * (ring - .28);
  Tin *= 1. - .85 * costa;
  float wall = exp(-sq(e / (1.1 * sc + blurE)));
  float halo = exp(-sq((e + 2.5 * sc + blurE) / (1.6 * sc + blurE)));
  float T = mix(1. + .03 * B * halo, Tin * (1. - .38 * wall), inV);
  aT *= T;
  aG += inV * (.07 + gK * attP * (.55 * ring * max(C, 0.) + .45 * pm * max(-C, 0.)) + .45 * costa) + .6 * wall * inV
      + .2 * halo * max(B, 0.) * (1. - inV);
  aH += inV * (1. - .55 * pm + .9 * costa);
}

float SH_thB;   // direction of the big rim piece (set once in main)
// shard slot fi: angular offset dth from the rim piece (away from it, toward the free side), radius rho
// (valve radii), size (areola pitches), depth (relative to the focal plane)
// Each chip takes whichever side of the break keeps it on screen and off the text (cards included).
void shardSlot(vec2 p, float fi, float dth, float rho, float sizeK, float dz, vec2 vc, float Rv, float R0, float side,
               float sd, float tau, float focus, vec2 res, vec4 cr) {
  float hs = hash11(sd * 71.3 + fi * 13.7);
  float pitch = .0192 * R0, size = pitch * sizeK, depth = focus + dz;
  float a = dth + .06 * (hs - .5);
  vec2 cA = vc + Rv * rho * vec2(fcos(SH_thB - side * a), fsin(SH_thB - side * a));
  vec2 cB = vc + Rv * rho * vec2(fcos(SH_thB + side * a), fsin(SH_thB + side * a));
  vec2 crC = cr.xy + .5 * cr.zw, crB = .5 * cr.zw + 36. + size;
  vec2 m = .5 * res - size;
  float okA = step(0., sdRoundBox(cA - crC, crB, 22.)) * step(max(abs(cA.x - .5 * res.x) - m.x, abs(cA.y - .5 * res.y) - m.y), 0.);
  float okB = step(0., sdRoundBox(cB - crC, crB, 22.)) * step(max(abs(cB.x - .5 * res.x) - m.x, abs(cB.y - .5 * res.y) - m.y), 0.);
  vec2 c = (okA > 0. ? cA : cB)
         + vec2(fsin(tau + fi * 2.1), .8 * fsin(2. * tau + fi * 1.3)) * (5. + 3. * hs);   // <= ~0.25 px/s
  float reach = 1.25 * size + 3. * (.35 + 2.4 * abs(dz * gDof)) + 8.;
  if (okA + okB > 0. && dot(p - c, p - c) < reach * reach)
    shard(p, c, size, hs * TAU + .06 * fsin(tau + fi), depth, focus, pitch, hs);
}

void main() {
  float dpr = max(u_pixelRatio, .25);
  vec2 res = u_resolution / dpr;
  vec2 p = gl_FragCoord.xy / dpr;
  gAA = .7 / dpr;
  float t = mod(u_time, T_PERIOD);
  float tau = TAU * t / T_PERIOD;
  float sd = p_composition;
  int mode = p_imaging;
  gDof = mix(.7, 1.45, p_aperture);
  gK = mix(1.18, .84, p_aperture);
  float focus = p_focus;

  // ---- composition: the same block as shader.frag (valve centre vc, radius R0) ----
  vec4 cr = u_contentRect / dpr;
  if (cr.z < 1. || cr.w < 1.) {
    float w = min(760., res.x - 40.);
    float hh = min(420., res.y * .5);
    cr = vec4((res.x - w) * .5, res.y - 56. - hh, w, hh);
  }
  float headH = min(cr.w * .36, 150.);
  float h1 = hash11(sd * 29.7 + .71), h2 = hash11(sd * 41.3 + .37);
  float side = p_corner == 0 ? 1. : -1.;
  float R0 = p_magnification * min(.8 * res.y, .92 * res.x + 60.);
  vec2 vc;
  float portrait = step(res.x, res.y);
  float inset = mix(.06 + .1 * h1, .02 + .06 * h1, portrait);
  vc.x = side > 0. ? res.x - inset * R0 : inset * R0;
  float yHi = cr.y + cr.w - headH - 34. - R0;
  vc.y = max(min(.03 * R0 + .05 * R0 * h2, yHi), -.35 * R0);
  float Rv = R0 * (1. + .012 * focus / 1.65);
  vec2 headC = vec2(cr.x + cr.z * .5, cr.y + cr.w - headH * .5);
  vec2 headB = vec2(cr.z * .5, headH * .5) + 14.;

  // ---- debris: one candidate per cell, creeping with the mountant ----
  {
    float cs = 58. * R0 / 468. + 18.;
    vec2 cid = floor(p / cs);
    ivec2 tc = (ivec2(cid) + ivec2(int(sd * 997.), 71)) & 255;
    vec4 hd = texelFetch(u_noiseTexture, tc, 0);
    // density bound from the cell centre (the particle stays within .23 cs of it)
    float dv0 = length((cid + .5) * cs - vc) / Rv, dm = .33 * cs / Rv;
    float dx = max(max(dv0 - dm - 1.08, 1.08 - dv0 - dm), 0.);
    if (hd.x < .04 + .5 * exp(-sq(dx / .22)) + .12 * step(dv0 - dm, 1.)) {
      vec2 j = texelFetch(u_noiseTexture, (tc + ivec2(0, 131)) & 255, 0).xy - .5;
      float depth = (fract(hd.z * 7.) - .5) * 4.4;
      float size = mix(.9, 4.2, sq(hd.y)) * (.6 + .4 * R0 / 468.);
      float z = (focus - depth) * gDof;
      float bl = .35 + 1.9 * abs(z);
      // laminar creep: one slow loop for the layer, scaled by height in the mount, + a tiny wobble
      float lift = .55 + .45 * (depth + 2.2) / 4.4;
      vec2 creep = vec2(fsin(tau), .7 * fsin(2. * tau + 1.3)) * (.06 * cs) * lift
                 + vec2(fsin(2. * tau + 6.28 * hd.w), fcos(3. * tau + 6.28 * hd.z)) * (.012 * cs);
      vec2 cc = (cid + .5 + j * .2) * cs + creep;
      // reach: shape <= 2.1 size, blur bl -> every term < 1e-4 beyond
      float reach = 2.8 * size + max(3. * (.9 + bl), 1.7 * bl + 5.2) + 2.;
      if (dot(p - cc, p - cc) < reach * reach) {
        float dv = length(cc - vc) / Rv;
        float sdHead = sdRoundBox(p - headC, headB, 22.);
        float dens = (.04 + .5 * exp(-sq((dv - 1.08) / .22)) + .12 * step(dv, 1.)) * smoothstep(0., 30., sdHead);
        if (hd.x < dens) {
          vec2 rel = rot(hd.z * 6.28 + .05 * fsin(tau + hd.w * 6.28)) * (p - cc);
          float typ = fract(hd.y * 5.3);
          float dsh = typ < .55 ? length(rel) - size
                    : (typ < .85 ? sdRoundBox(rel, vec2(size * 1.9, size * .75), size * .3) + .5 * size * tri(rel.x * .4)
                                 : length(vec2(max(abs(rel.x) - size * 1.3, 0.), rel.y)) - size * .45);
          float sz = typ < .55 ? size : size * 1.2;
          float cov = smoothstep(bl + gAA, -bl - gAA, dsh) * sat(sz / (sz + .45 * bl));
          float dcen = dsh + sz, radD = sz + 1.3 * bl, dfw = sat((bl - 1.) / 2.5);
          float disc = smoothstep(radD + 1.2, radD - 1.2, dcen) * sat(1.6 * sz * sz / (radD * radD) + .08);
          cov = mix(cov, disc, dfw);
          float rim = exp(-sq((dcen - radD) / (.9 + .1 * bl)));
          float bz = fsin(1.35 * z) * exp(-.12 * z * z);
          // soft cell window: a particle never shows a hard cut at its cell border
          vec2 fc = abs(fract(p / cs) - .5) * cs;
          float win = smoothstep(.5 * cs, .5 * cs - 6., max(fc.x, fc.y));
          aT *= mix(1., (1. - .55 * cov) + .1 * bz * rim * dfw * sat(4. * sz / radD), win);
          aG += win * (.7 * exp(-sq(dsh / (.9 + bl))) * sat(sz / (sz + .6 * bl)) + .1 * cov);
          aH += win * 1.2 * cov;
        }
      }
    }
  }

  // ---- loose silica shards: three chips beside the rim, off the break and clear of the headline ----
  {
    vec2 bdS = rot((h2 - .5) * .6) * normalize(vec2(-side, .3));   // where the big rim piece lies
    SH_thB = atan(bdS.y, bdS.x);
    // three explicit calls, not a loop: under ANGLE/Metal a loop around this branch cost ~0.4 ms
    shardSlot(p, 0., .34, 1.11, 2.4, -.15, vc, Rv, R0, side, sd, tau, focus, res, cr);
    shardSlot(p, 1., .17, 1.36, 1.7, -1.1, vc, Rv, R0, side, sd, tau, focus, res, cr);
    shardSlot(p, 2., .03, 1.62, 2.0, .55, vc, Rv, R0, side, sd, tau, focus, res, cr);
  }

  // ---- composite onto the cached base ----
  vec3 base = texelFetch(u_base, ivec2(gl_FragCoord.xy), 0).rgb;
  vec3 col = base;
  vec2 uvn = (p - res * vec2(.42, .6)) / res.y;
  if (mode == 1) {
    // darkfield: added scatter through the base's film shoulder, exactly: 1 - (1 - base) e^(-k G)
    vec3 k = 1. - exp(-1.25 * aG * gK * vec3(.72, .84, 1.));
    if (u_dark > .5) col = 1. - (1. - base) * (1. - k);
    else {
      float illum = 1. - .065 * smoothstep(.1, 1.15, length(uvn * vec2(.85, 1.)));
      vec3 paper = vec3(.953, .957, .962) * illum, w = vec3(1.05, 1., .92);
      vec3 bg = vec3(.010, .012, .018) + vec3(.004, .006, .012) * (1. - length(uvn));
      vec3 cTm = bg + (1. - base / paper) / (.9 * w);            // the base's tone-mapped scatter
      col = base - paper * .9 * w * (1. - cTm) * k;
    }
  } else if (mode == 2) {
    float Hs = aH * 1.1;
    float rel = (dFdx(Hs) + dFdy(Hs)) * .7071 * dpr;
    col = base * (1. + 1.25 * rel) * mix(vec3(1.), aT, .22);
  } else {
    col = base * aT;
  }

  // ---- film grain: fresh every frame (hashed whole-texel offset, t * 30 steps >= 1 per 20 fps frame),
  // fine 1 px grain + a little 2 px clumping, ~unit std; strongest in the mid-tones ----
  uint fr = lb32(uint(floor(t * 30.)) + 0x51u);
  vec2 gp = floor(gl_FragCoord.xy) + vec2(float(fr & 255u), float((fr >> 8u) & 255u));
  vec2 gn = textureLod(u_noiseTexture, (gp + .5) / 256., 0.).rg;
  float gc = textureLod(u_noiseTexture, (gp + vec2(38., 92.)) / 256., 0.).b;
  float film = ((gn.x + gn.y - 1.) + 1.4 * (gc - .5)) * 2.2;
  float lum = dot(col, vec3(.3, .55, .15));
  float gAmp = max(p_grain * .043 * (.45 + 2.2 * lum * (1. - lum)) * (u_dark > .5 ? .8 : 1.), .6 / 255.);
  col += film * gAmp * vec3(1., .98, 1.03);
  fragColor = vec4(clamp(col, 0., 1.), 1.);
}
