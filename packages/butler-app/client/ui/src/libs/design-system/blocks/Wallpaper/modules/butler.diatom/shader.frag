// butler.diatom — Diatom Areolae (규조 격자)
//
// One centric diatom valve seen through a transmitted-light microscope: off-centre,
// cropped by the frame, with a broken rim piece lying beside it and out-of-focus dust discs on
// the optics. The valve is magnified so its lattice fills one lower corner (param `corner`).
//
// Two-pass module (engine prototype): this file is the STATIC base. It never reads u_time, so
// the engine renders it once into a cached texture (u_base) whenever a non-time input changes;
// overlay.frag runs every frame on top of it: slowly drifting debris and loose silica shards in
// the mountant, then film grain. Nothing on the valve itself moves.
//
// One light path: condenser below -> specimen -> objective focused at p_focus.
// Every structure has a depth; z = focus - depth drives
//   C(z)  even areola contrast: flips sign, so the pore halftone inverts itself,
//   B(z)  odd Becke line: the bright halo swaps sides as focus passes a boundary,
//   blur  grows with |z| (areola pitch vanishes first, costae last),
//   axial chromatic aberration: z offset per channel -> faint colour fringes.
// The valve is domed and slightly tilted, so the thin in-focus slice is an off-centre band
// across it; costae sit deeper than the pore plate.
// Nested scales (~180 um valve at ~250x): valve diameter 2R; costa pitch ~0.1R at the rim;
// areola pitch ~0.019R.
// Cost (1440x900, before the split; now paid once per input change, ~1.2 ms): valve ~0.77 ms,
// of which the costa-candidate scan ~0.25 and the broken-rim chip field ~0.11.

#define TAU 6.28318530718
#define PI 3.14159265359

float gAA;    // one drawing-buffer pixel, in css px
float gDof;   // defocus scale (condenser aperture)
float gCA;    // axial chromatic offset, DOF units
float gK;     // contrast (condenser aperture)

// fast sine/cosine (|error| < 1.1e-3): a refined parabola on the reduced angle. The Metal
// back end's precise sin/cos cost several times more and nothing here needs more accuracy.
float fsin(float x) {
  x *= .15915494; x -= floor(x + .5);                // turns, in [-.5, .5)
  float y = x * (8. - 16. * abs(x));
  return .225 * (y * abs(y) - y) + y;
}
float fcos(float x) { return fsin(x + 1.5707963); }
vec3 fsin(vec3 x) { return vec3(fsin(x.x), fsin(x.y), fsin(x.z)); }
vec3 fcos(vec3 x) { return vec3(fcos(x.x), fcos(x.y), fcos(x.z)); }

float sq(float x) { return x * x; }
float sat(float x) { return clamp(x, 0., 1.); }
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash32(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
float vnoise(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3. - 2. * f);
  return textureLod(u_noiseTexture, (i + f + .5) / 256., 0.).r;
}
mat2 rot(float a) { float c = fcos(a), s = fsin(a); return mat2(c, s, -s, c); }
float sdRoundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
float tri(float x) { return abs(fract(x) - .5); }

// ---------------- optics ----------------
vec3 contrastC(vec3 z) { return fcos(1.35 * z) * exp(-.1 * z * z); }   // even
vec3 beckeB(vec3 z) { return fsin(1.35 * z) * exp(-.22 * z * z); }      // odd
// C and B for the three colour channels at z + (gCA, -gCA, .7 gCA): value + first-order
// Taylor step (gCA = .03, so the dropped second-order term is < 1e-3 of the field).
void opticsCB(float z, out vec3 C, out vec3 B, out float B0) {
  float s = fsin(1.35 * z), c = fcos(1.35 * z);
  float e1 = exp(-.1 * z * z), e2 = exp(-.22 * z * z);
  vec3 off = vec3(gCA, -gCA, gCA * .7);
  C = c * e1 + (-1.35 * s - .2 * z * c) * e1 * off;
  B0 = s * e2;
  B = B0 + (1.35 * c - .44 * z * s) * e2 * off;
}
vec3 beckeCA(float z) {
  float s = fsin(1.35 * z), c = fcos(1.35 * z), e2 = exp(-.22 * z * z);
  return s * e2 + (1.35 * c - .44 * z * s) * e2 * vec3(gCA, -gCA, gCA * .7);
}

struct Px { vec3 T; vec3 G; float H; float pig; };   // BF transmission, DF scatter, optical path, pigment

// ---------------- valve geometry ----------------
struct Geo {
  float dP, rp, fill, present;   // nearest areola: distance, radius, area fraction, exists
  float dCo, hwCo;               // nearest costa: signed edge distance (px), half width
  float dRu, hwRu, rungOn;       // nearest rung
  float hyal;                    // hyaline central area
  float rimW;                    // marginal band width
  float cellV;                   // per-compartment silica thickness variation
};

void costaCand(float k0, int k0i, int i, float r, float a, float sd,
               inout float aL, inout float jL, inout float lvL, inout float stL,
               inout float aR, inout float lvR, inout float stR) {
  int ji = (k0i + i) & 63;
  float jm = float(ji);
  float lv = (ji & 3) == 0 ? 0. : ((ji & 1) == 0 ? 1. : 2.);
  float hj = hash11(jm * 7.31 + sd * 13.);
  float st = lv < .5 ? .18 : (lv < 1.5 ? .33 + .13 * hj : .55 + .22 * fract(hj * 9.1));
  if (r >= st) {
    float pos = k0 + float(i) + (hj - .5) * .3 + .14 * fsin(r * 7. + hj * 6.28);
    if (pos <= a && pos > aL) { aL = pos; jL = jm; lvL = lv; stL = st; }
    if (pos > a && pos < aR) { aR = pos; lvR = lv; stR = st; }
  }
}

Geo geoRadial(vec2 q, float R, float sd, float th) {
  Geo g;
  g.dP = 1e3; g.rp = 1.; g.fill = .4; g.present = 0.;
  g.dCo = 1e3; g.hwCo = 1.; g.dRu = 1e3; g.hwRu = 1.; g.rungOn = 0.; g.hyal = 0.; g.cellV = 0.;
  g.rimW = .046 * R;
  float r = length(q) / R;
  float sp = .0192 * R;
  if (r < .185) {
    // central area: hyaline disc ringed by two rows of large areolae
    float row = r < .142 ? 0. : 1.;
    float nn = row < .5 ? 19. : 26.;
    float rc = row < .5 ? .124 : .162;
    float ang = (th / TAU + .5) * nn + row * .37;
    float cid = floor(ang);
    vec3 hc = hash32(vec2(cid, row) + sd * 5.);
    vec2 dxy = vec2((fract(ang) - .5) * TAU / nn * rc * R, (r - rc) * R);
    dxy += (hc.xy - .5) * .2 * sp;
    g.rp = (row < .5 ? .0112 : .0096) * R * (.88 + .24 * hc.z);
    g.dP = mix(length(dxy), max(abs(dxy.x), abs(dxy.y)), .2);
    g.fill = 3.1 * g.rp * g.rp / (TAU / nn * rc * R * .038 * R);
    g.present = step(.05, fract(hc.z * 7.3));
    g.hyal = 1. - smoothstep(.099, .107, r);
    return g;
  }
  // ---- costae: 16 primary from the centre, 16 secondary and 32 tertiary inserted
  // at irregular radii, so the pitch stays roughly even (as in Arachnoidiscus) ----
  float a = (th / TAU + .5) * 64.;
  float k0 = floor(a);
  float aL = -1e4, aR = 1e4, jL = 0., lvL = 0., lvR = 0., stL = 0., stR = 0.;
  // Exact window: costa positions sit within +-.29 of their index. Levels 0/1/2 are all
  // present beyond r=.77 (pitch 1), levels 0/1 beyond r=.46 (pitch 2), level 0 always (pitch 4);
  // with pitch s the nearest left/right costae lie in [k0-s, k0+s+1] (the original scanned +-5).
  // Straight-line code: 4 candidates always, 2 more below r=.77, 4 more below r=.46.
  int k0i = int(k0);
  costaCand(k0, k0i, -1, r, a, sd, aL, jL, lvL, stL, aR, lvR, stR);
  costaCand(k0, k0i, 0, r, a, sd, aL, jL, lvL, stL, aR, lvR, stR);
  costaCand(k0, k0i, 1, r, a, sd, aL, jL, lvL, stL, aR, lvR, stR);
  costaCand(k0, k0i, 2, r, a, sd, aL, jL, lvL, stL, aR, lvR, stR);
  if (r < .77) {
    costaCand(k0, k0i, -2, r, a, sd, aL, jL, lvL, stL, aR, lvR, stR);
    costaCand(k0, k0i, 3, r, a, sd, aL, jL, lvL, stL, aR, lvR, stR);
    if (r < .46) {
      costaCand(k0, k0i, -4, r, a, sd, aL, jL, lvL, stL, aR, lvR, stR);
      costaCand(k0, k0i, -3, r, a, sd, aL, jL, lvL, stL, aR, lvR, stR);
      costaCand(k0, k0i, 4, r, a, sd, aL, jL, lvL, stL, aR, lvR, stR);
      costaCand(k0, k0i, 5, r, a, sd, aL, jL, lvL, stL, aR, lvR, stR);
    }
  }
  float arcPx = TAU / 64. * r * R;
  float hwL = R * (lvL < .5 ? .0064 : (lvL < 1.5 ? .0052 : .0043)) * smoothstep(stL, stL + .035, r);
  float hwR = R * (lvR < .5 ? .0064 : (lvR < 1.5 ? .0052 : .0043)) * smoothstep(stR, stR + .035, r);
  float dL = (a - aL) * arcPx, dR = (aR - a) * arcPx;
  float eL = dL - hwL, eR = dR - hwR;
  g.dCo = min(eL, eR);
  g.hwCo = eL < eR ? hwL : hwR;
  float f = (a - aL) / (aR - aL);
  float wpx = (aR - aL) * arcPx;
  // ---- rungs: arcs between costae, bowed outward, own phase per sector ----
  float hs = hash11(jL * 3.7 + 11. + sd * 7.);
  float rs = .04 + .016 * hs;
  float r0 = (r - .18) / rs;
  float wob = r0 * 1.9 + hs * 17.;
  float rho = r0 + hs * 5. - .24 * f * (1. - f) * 4. + .1 * fsin(wob) + .06 * fsin(f * 5.3 + wob * .37);   // web-like wobble
  float drho = 1. + .19 * fcos(wob);                           // local rung pitch change
  float n = floor(rho), gg = fract(rho);
  g.hwRu = .0032 * R;
  g.dRu = min(gg, 1. - gg) * rs * R / drho - g.hwRu;
  float hcell = hash12(vec2(jL, n) + sd * 3.);
  g.rungOn = step(.13, hcell);
  g.cellV = fract(hcell * 7.7) - .5;
  // ---- areolae: small grid inside each costa/rung cell ----
  float cellR = rs * R / drho;
  float inW = max(wpx - hwL - hwR, 1.), inR = max(cellR - 2. * g.hwRu, 1.);
  float nA = max(1., floor(inW / sp + .2));
  float nR = max(1., floor(inR / sp + .3));
  float uu = clamp((f * wpx - hwL) / inW, 0., .999) * nA;
  float vv = clamp((gg * cellR - g.hwRu) / inR, 0., .999) * nR;
  vec2 cellPx = vec2(inW / nA, inR / nR);
  vec2 dxy = (fract(vec2(uu, vv)) - .5) * cellPx;
  vec3 hp = hash32(vec2(jL * 97. + n * 3.1, floor(uu) * 13. + floor(vv) + n * 71.) + sd * 17.);
  vec2 jit = (hp.xy - .5) * .08 * sp;
  dxy += jit;
  g.rp = min(min(cellPx.x, cellPx.y) * (.35 + .08 * hp.z), .5 * min(cellPx.x, cellPx.y) - max(abs(jit.x), abs(jit.y)) - .6);
  g.dP = mix(length(dxy), max(abs(dxy.x), abs(dxy.y)), .12);
  g.fill = 3.3 * g.rp * g.rp / (cellPx.x * cellPx.y);
  g.present = step(.025, fract(hp.z * 11.7));
  // outer zone: larger, irregular marginal chambers (partly silted), as in the reference
  float outer = smoothstep(.83, .9, r);
  if (outer > 0.) {
    float nz = vnoise(q / (sp * .9) + sd * 11.) - .5;
    g.dP = mix(g.dP, g.dP * (1. + .5 * nz) + .8 * sp * nz, outer);
    g.rp *= 1. + .25 * outer;
    g.cellV += outer * nz * 1.6;
    g.present *= step(.12 * outer, fract(hp.z * 5.1));
  }
  return g;
}

vec2 hexNearest(vec2 p, out vec2 id) {
  const vec2 s = vec2(1., 1.7320508);
  vec4 hc = floor(vec4(p, p - vec2(.5, 1.)) / s.xyxy) + .5;
  vec4 h = vec4(p - hc.xy * s, p - (hc.zw + .5) * s);
  if (dot(h.xy, h.xy) < dot(h.zw, h.zw)) { id = hc.xy; return h.xy; }
  id = hc.zw + .5; return h.zw;
}

Geo geoAreolate(vec2 q, float R, float sd) {
  Geo g;
  g.dCo = 1e3; g.hwCo = 1.; g.dRu = 1e3; g.hwRu = 1.; g.rungOn = 0.; g.hyal = 0.; g.cellV = 0.;
  g.rimW = .034 * R;
  float r = length(q) / R;
  float sp = .024 * R;
  // areolae coarse at the centre, finer toward the margin, rows gently twisted
  float k = 1. + .85 * r * r;
  vec2 L = rot(.32 * r) * q * k / sp;
  vec2 id;
  vec2 h = hexNearest(L, id);
  float pitch = sp / (k + 1.7 * r * r);
  vec3 hp = hash32(id + sd * 23.);
  h += (hp.xy - .5) * .1;
  g.dP = length(h) * pitch;
  g.rp = pitch * (.34 + .07 * hp.z);
  g.fill = 3.63 * sq(g.rp / pitch);
  g.present = step(.003, fract(hp.z * 13.1));
  // central rosette: a ring of 7 large areolae around a small clear centre
  if (r < .075) {
    float th = atan(q.y, q.x);
    float ang = (th / TAU + .5) * 7.;
    float rc = .048;
    vec2 dxy = vec2((fract(ang) - .5) * TAU / 7. * rc * R, (r - rc) * R);
    g.rp = .0145 * R;
    g.dP = length(dxy);
    g.fill = .45;
    g.present = 1.;
    g.hyal = 1. - smoothstep(.022, .028, r);
  }
  return g;
}

// broken rim: a V-shaped chip, signed distance-ish in R units (> 0 inside the missing chip)
float chipField(float r, float th, float thB) {
  float dth = thB - th;                        // = atan(cross(qn, bd), dot(qn, bd)), wrapped to (-pi, pi]
  dth -= TAU * floor(dth / TAU + .5);
  float jag = .022 * tri(dth * 7.3 + .3) + .03 * (vnoise(vec2(dth * 23., 3.1)) - .5) + .012 * (vnoise(vec2(dth * 71., 7.7)) - .5);
  float slope = dth > 0. ? 1.25 : .82;
  float thr = .57 + slope * abs(dth) + jag;
  return (r - thr) / sqrt(1. + sq(slope / max(r, .3)));
}

Px valveShade(vec2 q, float R, float zP, float sd, bool radial, int MODE, float th) {
  Px o; o.T = vec3(1.); o.G = vec3(0.); o.H = 0.; o.pig = 0.;
  float r = length(q) / R;
  float e = (1. - r) * R;                               // px inside the edge
  if (e < -10.) return o;
  Geo g;
  if (radial) g = geoRadial(q, R, sd, th); else g = geoAreolate(q, R, sd);
  float aa = gAA;
  float sc = R / 468.;
  float sp = (radial ? .0192 : .02) * R;
  float zs = zP * gDof;
  vec3 Cc, Bc;
  float B0;
  opticsCB(zs, Cc, Bc, B0);
  float blurP = sp * (.06 + .14 * abs(zs));
  float attP = exp(-2.2 * sq(blurP / sp));
  float zC = (zP + .75) * gDof;                         // internal costae sit deeper
  float blurC = (.4 + 1.5 * abs(zC)) * sc;
  vec3 BcC = beckeCA(zC);
  float blurE = (.5 + 2.4 * abs(zs)) * sc;              // edge blur

  float inV = smoothstep(-aa, aa, e);
  float poreZone = (1. - g.hyal) * smoothstep(g.rimW - 1., g.rimW + 2.5, e);

  // areolae
  float se = min(blurP, .55 * g.rp) + aa;
  float pm = mix(.3, 1., g.present) * (1. - smoothstep(g.rp - se, g.rp + se, g.dP));
  float ring = exp(-sq((g.dP - g.rp) / (.28 * g.rp + se)));
  float speck = vnoise(q / (sp * 1.7) + sd * 9.) - .5;             // defocused areolae turn to mottle
  vec3 T = vec3(.57 - .09 * g.cellV);
  T += poreZone * (.86 * gK * attP * Cc * (pm - g.fill) + .12 * attP * Bc * (ring - .28));
  T += poreZone * .16 * speck * (1. - attP);
  T = min(T, vec3(1.02));
  // hyaline centre: pale, organically mottled
  float mott = g.hyal > 0. ? vnoise(q / (R * .016) + sd * 40.) - .5 : 0.;
  T = mix(T, vec3(.86 + .14 * mott * (.4 + .6 * attP)), g.hyal);
  // costae and rungs (deeper layer)
  float edC = blurC + aa;
  float costa = smoothstep(edC, -edC, g.dCo) * g.hwCo / (g.hwCo + .6 * blurC);
  float rung = g.rungOn * smoothstep(edC, -edC, g.dRu) * g.hwRu / (g.hwRu + .6 * blurC);
  float cFr = exp(-sq((g.dCo - blurC - 1.2) / (1. + blurC)));
  T *= 1. - .92 * costa - .72 * rung * (1. - costa);
  T += .12 * BcC * cFr;
  // marginal band with fine mantle slits
  float rimB = smoothstep(g.rimW + 1., g.rimW - 1.5, e);
  float slit = 0.;
  if (rimB > 0.) {
    float nT = floor(TAU * R / (.0105 * R));
    float tk = fract((th / TAU + .5) * nT);
    slit = (1. - smoothstep(.16, .3, abs(tk - .5))) * smoothstep(.12, .32, e / g.rimW) * smoothstep(.95, .7, e / g.rimW);
  }
  float rimT = .34 + .38 * slit * attP * (.5 + .5 * Cc.g);
  T = mix(T, vec3(rimT), rimB);
  // outer edge: dark silica wall, Becke halo outside
  float wall = exp(-sq(e / (1.1 * sc + blurE)));
  T *= 1. - .55 * wall;
  float halo = exp(-sq((e + 2.5 * sc + blurE) / (1.6 * sc + blurE)));
  if (MODE != 1) o.T = mix(vec3(1.) + .16 * Bc * halo, T, inV);
  if (MODE != 1) { o.H = inV * (1. + .35 * rimB) - .55 * pm * poreZone + .9 * costa + .45 * rung; return o; }

  // darkfield: scatter from edges, pore walls, costae
  vec3 G = vec3(.05);
  float Cm = dot(Cc, vec3(1. / 3.));
  G += poreZone * ((.07 + .04 * g.cellV) + gK * attP * (.62 * ring * max(mix(vec3(Cm), Cc, .5), 0.) + .5 * pm * max(-Cm, 0.)) + .07 * speck * (1. - attP));
  G = mix(G, vec3(.05 + .05 * mott), g.hyal);
  G += .46 * costa + .32 * cFr * (.6 + .4 * BcC) * (1. - costa) + .24 * rung;
  G = mix(G, vec3(.26 + .45 * slit * attP), rimB);
  G += .85 * wall;
  o.G = G * inV + .35 * halo * max(Bc, 0.) * (1. - inV);
  return o;
}

void main() {
  float dpr = max(u_pixelRatio, .25);
  vec2 res = u_resolution / dpr;
  vec2 p = gl_FragCoord.xy / dpr;
  gAA = .7 / dpr;
  float sd = p_composition;
  int mode = p_imaging;                     // 0 brightfield, 1 darkfield, 2 DIC
  bool radial = p_species == 0;
  gDof = mix(.7, 1.45, p_aperture);
  gK = mix(1.18, .84, p_aperture);
  gCA = .03;

  // ---- content rect (css px, y up) ----
  vec4 cr = u_contentRect / dpr;
  if (cr.z < 1. || cr.w < 1.) {
    float w = min(760., res.x - 40.);
    float hh = min(420., res.y * .5);
    cr = vec4((res.x - w) * .5, res.y - 56. - hh, w, hh);
  }
  float headH = min(cr.w * .36, 150.);
  float compTop = res.x < 560. ? 112. : 130.;

  // ---- composition (uniform; overlay.frag repeats this block to place its debris) ----
  float h0 = hash11(sd * 17.31 + .13), h1 = hash11(sd * 29.7 + .71), h2 = hash11(sd * 41.3 + .37), h3 = hash11(sd * 53.9 + .91);
  float side = p_corner == 0 ? 1. : -1.;            // lower-right (default) or lower-left
  // magnified: the valve's centre sits near the bottom corner, so its lattice fills that
  // lower quadrant while the top stays clear of the headline
  float R0 = p_magnification * min(.8 * res.y, .92 * res.x + 60.);
  vec2 vc;
  float portrait = step(res.x, res.y);
  float inset = mix(.06 + .1 * h1, .02 + .06 * h1, portrait);      // the centre sits just inside the corner
  vc.x = side > 0. ? res.x - inset * R0 : inset * R0;
  float yHi = cr.y + cr.w - headH - 34. - R0;       // valve top stays below the headline
  vc.y = max(min(.03 * R0 + .05 * R0 * h2, yHi), -.35 * R0);

  Px acc; acc.T = vec3(1.); acc.G = vec3(0.); acc.H = 0.; acc.pig = 0.;

  // ---- valve (main + broken piece) ----
  {
    float vrot = h3 * TAU;
    float cv = fcos(vrot), sv = fsin(vrot);
    mat2 rv = mat2(cv, -sv, sv, cv);                   // rot(-vrot)
    vec2 q = rv * (p - vc);
    q.y /= .968;                              // slight tilt ellipse
    // coarse reject with the largest breathing radius, exact test inside
    float Rmax = R0 * 1.0125;
    vec2 bdS = rot((h2 - .5) * .6) * normalize(vec2(-side, .3));
    vec2 bd = rv * bdS;                       // break direction, valve frame
    vec2 bp = vec2(-bd.y, bd.x);
    vec2 P0 = bd * .8;
    float fsg = h1 < .5 ? 1. : -1.;
    mat2 rf = mat2(fcos(.24), -fsg * fsin(.24), fsg * fsin(.24), fcos(.24));   // rot(-fang)
    vec2 qfm = rf * (q / Rmax - P0 - bd * .085 - bp * .03) + P0;
    if (dot(q, q) < sq(1.035 * Rmax) || dot(qfm, qfm) < sq(1.05)) {
      float focus = p_focus;                    // static focal plane (the overlay uses the same one)
      float Rv = R0 * (1. + .012 * focus / 1.65);   // focus breathing: the image scale follows the focus
      vec2 qn = q / Rv;
      vec2 qf = rf * (qn - P0 - bd * .085 - bp * .03) + P0;
      float rM = length(qn), rF = length(qf);
      float thB = atan(bd.y, bd.x);
      float thM = atan(qn.y, qn.x);
      // chip fields only near the valve discs
      // the V chip spans < 1 rad either side of bd: beyond that the rim is intact and the fracture
      // terms vanish (eb > 50 px), so the chip field is only evaluated inside the wedge
      float cM = rM < 1.03 ? (dot(qn, bd) > .54 * rM ? chipField(rM, thM, thB) : -1.) : 1.;   // wedge |dth| < 1 rad
      bool inMain = rM < 1.03 && cM < .006;
      float thF = 0., cF = -1.;
      if (!inMain && rF < 1.03) { thF = atan(qf.y, qf.x); cF = chipField(rF, thF, thB); }
      bool inFrag = !inMain && rF < 1.03 && cF > -.006;
      if (inMain || inFrag) {
        vec2 tdir = rv * normalize(res * vec2(.5, .55) - vc + vec2(1e-3));   // visible side of the valve spans the full depth range
        vec2 qq = inMain ? qn : qf;
        float cc = inMain ? cM : cF;
        float th = inMain ? thM : thF;
        float r = inMain ? rM : rF;
        float depth = 1.5 * (1. - r * r) - .75 + 1.35 * dot(qq, tdir) + (inMain ? 0. : .95);
        float zP = focus - depth;
        float zs0 = zP * gDof, B0 = fsin(1.35 * zs0) * exp(-.22 * zs0 * zs0);
        Px v;
        if (mode == 0) v = valveShade(qq * Rv, Rv, zP, sd, radial, 0, th);
        else if (mode == 1) v = valveShade(qq * Rv, Rv, zP, sd, radial, 1, th);
        else v = valveShade(qq * Rv, Rv, zP, sd, radial, 2, th);
        // fracture: jagged dark edge, missing silica beyond it, crack halo
        float eb = (inMain ? -cc : cc) * Rv;                     // px inside the remaining silica
        float blurE = (.5 + 2.4 * abs(zP * gDof)) * Rv / 468.;
        float keep = smoothstep(-gAA, gAA, eb) * step(r, 1.);
        float bw = exp(-sq(eb / (1.2 + blurE)));
        v.T = mix(vec3(1.) + .1 * B0 * exp(-sq((eb + 2.5 + blurE) / (1.6 + blurE))), v.T, keep);
        v.T *= 1. - .5 * bw * step(r, 1.);
        v.G = v.G * keep + .9 * bw * step(r, 1.);
        v.H *= keep;
        acc.T *= v.T; acc.G += v.G; acc.H += v.H;
      }
      // hairline crack running in from the break
      vec2 c0 = rot(-.12) * bd * .6;
      vec2 cdir = normalize(-bd + bp * .3);
      vec2 w = qn - c0, wm = w - cdir * .15;
      if (inMain && dot(wm, wm) < .031) {             // the crack is a .3 R segment: bounding circle first
        float s = clamp(dot(w, cdir), 0., .3);
        float dcr = length(w - cdir * s + bp * (.012 * tri(s * 11.) + .004 * tri(s * 37.))) * Rv;
        float crack = exp(-sq(dcr / (.7 + gAA))) * step(rM, .97) * smoothstep(.3, .16, s);
        acc.T *= 1. - .45 * crack;
        acc.G += .5 * crack;
      }
    }
  }

  // (debris in the mountant is drawn by overlay.frag: it drifts)

  // ---- dust on the optics: two far out-of-focus discs with a faint rim (branchless) ----
  float dust = 0., dustRim = 0.;
  {
    vec4 hh = texelFetch(u_noiseTexture, ivec2(int(sd * 613.), 203) & 255, 0);
    vec2 c1 = res * vec2(.08 + .84 * hh.x, .12 + .76 * hh.y), c2 = res * vec2(.08 + .84 * hh.z, .12 + .76 * hh.w);
    float s9 = res.y / 900.;
    vec2 rr = (vec2(30., 52.) + 30. * hh.xz) * s9;
    vec2 d = vec2(length(p - c1), length(p - c2));
    vec2 x = max(1. - (d - rr + 2.) * (d - rr + 2.) / 36., 0.), y = max(1. - (d - rr * .55) * (d - rr * .55) / 64., 0.);
    dust = dot(clamp((rr + 5. - d) / 10., 0., 1.), vec2(1.));
    dustRim = dot(x * x + .25 * y * y, vec2(1.));
  }

  // ---- illumination and imaging mode ----
  vec2 uvn = (p - res * vec2(.42, .6)) / res.y;
  float illum = 1. - .065 * smoothstep(.1, 1.15, length(uvn * vec2(.85, 1.)));
  float grain = (textureLod(u_noiseTexture, gl_FragCoord.xy / 256., 0.).b - .5) / 255.;
  vec3 col;
  if (mode == 1) {
    // darkfield: black field, silica glows cool white/blue; plastids glow golden
    vec3 bg = vec3(.010, .012, .018) + vec3(.004, .006, .012) * (1. - length(uvn));
    vec3 tint = vec3(.72, .84, 1.);
    vec3 G = acc.G * gK;
    G += vec3(.012, .015, .022) * (dust * .5 + dustRim);
    col = bg + G * tint * mix(1., .78, u_dark * 0.);
    col += acc.pig * vec3(.30, .20, .05) * .8;
    col = 1. - exp(-col * 1.25);                                  // film-like shoulder, no bloom
    if (u_dark < .5) {
      // light theme: print the darkfield scatter as ink on a pale field so the UI stays legible
      vec3 paper = vec3(.953, .957, .962) * illum;
      col = paper * (1. - .9 * (col - bg) * vec3(1.05, 1., .92));
    }
  } else if (mode == 2) {
    // DIC: slate field, shear-difference relief (45 deg), golden plastids
    vec3 slate = mix(vec3(.435, .514, .651), vec3(.19, .225, .29), u_dark);
    float Hs = acc.H * 1.1;
    float rel = (dFdx(Hs) + dFdy(Hs)) * .7071 * dpr;
    col = slate * illum * (1. + 1.25 * rel) * mix(vec3(1.), acc.T, .22);
    col = mix(col, vec3(.69, .54, .165) * (.75 + .5 * illum) * mix(1., .72, u_dark) * (1. + .8 * rel), acc.pig * .8);   // #b08a2a plastids
    col *= 1. - .03 * dust + .02 * dustRim;
  } else {
    // brightfield: white field (dimmed lamp in the dark theme)
    vec3 field = mix(vec3(.965, .965, .957), vec3(.145, .146, .15), u_dark) * illum;
    field *= 1. + .012 * vec3(-uvn.x, 0., uvn.x);
    vec3 T = acc.T;
    T *= 1. - .028 * dust + .018 * dustRim;
    col = field * T;
    col *= mix(vec3(1.), vec3(.93, .8, .5), acc.pig * .7);
  }
  col += grain;
  fragColor = vec4(clamp(col, 0., 1.), 1.);
}
