// butler.lamina — Lamina (이끼 잎), v0.2
// A moss leaf under a brightfield microscope at high magnification: chloroplast-filled
// laminal cells fill the lower part of the frame below a gently curving margin; the empty
// mounting medium above holds the headline.
//
// Light path: Köhler field (#eeedf3, slightly off-axis) -> leaf -> objective (thin focal slice, lateral + axial chromatic
// aberration, a touch of overall softness) -> sensor. Transmissions multiply (Beer–Lambert).
// Dark theme: the same brightfield leaf at a low lamp level on a near-black medium.
//
// Scale: the specimen is drawn at gK screen px per specimen unit (~2.6 at magnification 1),
// so laminal cells are ~52 x 35 px and chloroplasts ~12 px soft lenses. The leaf outline is
// placed in screen space from u_contentRect: the margin runs past the headline, so the text
// sits on empty medium above a gently curving, nearly horizontal margin.
//
// Motion (all loops at PERIOD = 300 s = timePeriod; at 1.5 px/s a ring makes 4 laps per period):
//   cyclosis     slow parietal chloroplast flow (~6 px/s), whole revolutions per period,
//                every plastid in a cell moving together
//   focus        gentle focus breathing between the upper leaf and slightly deeper, 5 / period
//   stage drift  1 and 2 cycles per period;  Brownian debris: noise sampled on a circle
//   film grain   a fresh fine-grain field every frame, luminance dependent (param `grain`)
//
// Cost notes (why the code looks the way it does):
//   * one 6-cell Voronoi pass per leaf (2 columns x 3 rows, proven sufficient for the
//     nearest cell; the same 6 cells give the wall bisectors), straight-line, no rehash
//   * chloroplasts only on the in-focus leaf (their detail is gone beyond ~2 RC of blur),
//     3 slots of one parietal ring + 3 slots of a small inner ring, per-ring culled
//   * everything outside both leaves returns after two dot products; debris is one
//     texel fetch per 150 px cell; no loops with break/continue or dynamic bounds
//   * chromatic aberration: per-channel offsets of the margin / wall / plastid distance
//     fields along their gradients (not three scene evaluations)

#define TAU 6.28318530718
#define PERIOD 300.0

// ---------------------------------------------------------------- hashing
uint lb32(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
uint hcell(ivec2 c, uint s) { return lb32(uint(c.x) * 0x9E3779B1u ^ uint(c.y) * 0x85EBCA77u ^ s); }
vec4 u4(uint h) { return vec4(uvec4(h, h >> 8u, h >> 16u, h >> 24u) & 255u) * (1.0 / 255.0); }

float nz(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(u_noiseTexture, (i + f + 0.5) / 256.0, 0.0).r;
}
vec2 nz2(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(u_noiseTexture, (i + f + 0.5) / 256.0, 0.0).gb;
}

float sq(float x) { return x * x; }
vec4 sq4(vec4 x) { return x * x; }
float sdRBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// ---------------------------------------------------------------- palette
// Linear RGB. Transmissions are relative to the field (#eeedf3 = 1).
const vec3 FIELD   = vec3(0.855, 0.8469, 0.8963);   // #eeedf3
const vec3 T_CHL_A = vec3(0.357, 0.4325, 0.0504);   // #96a33c
const vec3 T_CHL_B = vec3(0.2526, 0.3343, 0.0089);  // #809116
const vec3 T_WALL  = vec3(1.058, 1.088, 0.866);     // #f4f6e4, brighter than field
const vec3 T_COSTA = vec3(0.1195, 0.1736, 0.0153);  // #5a6b1f
const vec3 T_TIP   = vec3(0.8114, 0.8454, 0.6811);  // #d9dccd
const vec3 T_GAP   = vec3(0.74, 0.80, 0.42);        // cytoplasm between plastids (~#d0d6a2)

// ---------------------------------------------------------------- lattice (specimen units)
const float CL = 20.0;      // column pitch along the leaf axis (cells ~22 long, pointed ends)
const float CW = 13.5;      // cell pitch across
const float SHEAR = 0.36;   // oblique cell rows: costa -> margin, toward the tip
const float RC = 2.5;       // chloroplast radius: five large, separate lenses per cell (v0.1: 13 of 2.1)
const float HT = 0.62;      // mean wall half-thickness
const float CA_K = 0.0021;
const float B_LO = 4.4, B_HI = 5.7;  // screen px of blur: resolved path below B_HI, analytic defocus above B_LO, blended between  // lateral chromatic aberration: px of R/B shift per px off-axis

struct Leaf { vec2 tip; vec2 dir; float W; float taper; float costa; float z; uint seed; float tilt; float band; };

struct LOut {
  vec3 T;       // brightfield transmission
  float wall;   // wall coverage
  float chl;    // chloroplast coverage (defocus aware)
  float mean;   // cell-mean chlorophyll (haze, excitation shielding)
  float glow;   // leaf body coverage (the dark theme lights the tissue, not the medium)
  float fringe; // chromatic fringe just outside the margin
};

float gK, gBreath, gRackSign = 0.45, gPhase, gFocus, gBmax;
vec2 gHeadC, gHeadB, gRectC, gRectB, gCAs;

// leaf half-width (specimen units) at distance a from the tip
float halfW(Leaf L, float a) {
  float x = clamp(a / L.taper, 0.0, 1.0);
  return L.W * x * (2.0 - x) * (1.0 + 0.03 * sin(a * 0.013 + float(L.seed & 63u))) + max(a - L.taper, 0.0) * 0.05;
}
float squeeze(Leaf L, float hw) { return L.W / max(hw, 0.65 * L.W); }
float costaW(Leaf L, float a) { return L.costa * smoothstep(0.06 * L.taper, 0.7 * L.taper, a); }
float sab(float x) { return sqrt(x * x + 64.0); }

vec2 cellPt(ivec2 id, uint h) {
  vec4 r = u4(h);
  return vec2((float(id.x) + (r.x - 0.5) * 0.36) * CL,
              (float(id.y) + 0.5 * float(id.x & 1) + (r.y - 0.5) * 0.3) * CW);
}

// Specimen density near the text (screen px): 0 in the headline zone, ~0.5 under the cards.
float densScreen(vec2 q) {
  vec2 h = abs(q - gHeadC) - gHeadB, r = abs(q - gRectC) - gRectB;
  float dH = max(h.x, h.y), dR = max(r.x, r.y);
  return smoothstep(0.0, 170.0, dH) * mix(0.5, 1.0, smoothstep(-30.0, 90.0, dR));
}

// Thin line (surface distance d, half-width ht) under defocus b.
float lineCov(float d, float ht, float b, float aa) {
  float e = aa + b;
  return smoothstep(e, -e, d - 0.5 * b) * (ht + aa) / (ht + aa + b);
}
vec3 lineCov3(vec3 d, float ht, float b, float aa) {
  float e = aa + b;
  return smoothstep(vec3(e), vec3(-e), d - 0.5 * b) * (ht + aa) / (ht + aa + b);
}
// Disc edge (signed distance sd) under defocus b; rim = one-sided bokeh ring.
float discCov(float sd, float rad, float b, float aa, out float rim) {
  float e = aa + 0.3 * b;
  float body = smoothstep(e, -e, sd - b);
  float R = rad + b;
  rim = smoothstep(e + 0.7, 0.0, abs(sd - b + 0.7));
  float bokeh = 1.0 + gRackSign * rim * smoothstep(0.4, 2.0, b);
  return body * (rad * rad) / (R * R) * bokeh;
}

// p: screen px. blurS: base blur in screen px. Works in specimen units inside.
// 4 random bytes per lattice cell from the app noise texture (white, 256-periodic):
// one texel fetch instead of an integer hash per candidate cell.
vec4 cellRnd(ivec2 id, int salt) { return texelFetch(u_noiseTexture, (id + ivec2(salt, salt * 7)) & 255, 0); }
vec2 cellAt(ivec2 id, vec4 r) {
  return vec2((float(id.x) + (r.x - 0.5) * 0.36) * CL,
              (float(id.y) + 0.5 * float(id.x & 1) + (r.y - 0.5) * 0.3) * CW);
}
float fastAtan(float y, float x) {                 // |error| < 1e-3 rad; only picks plastid slots
  float ax = abs(x), ay = abs(y);
  float m = min(ax, ay) / max(max(ax, ay), 1e-9);
  float s2 = m * m;
  float r = ((-0.0464964749 * s2 + 0.15931422) * s2 - 0.327622764) * s2 * m + m;
  r = ay > ax ? 1.57079637 - r : r;
  r = x < 0.0 ? 3.14159274 - r : r;
  return y < 0.0 ? -r : r;
}

LOut mixL(LOut a, LOut s, float b) {
  float k = smoothstep(B_LO, B_HI, b * gK);
  return LOut(mix(a.T, s.T, k), mix(a.wall, s.wall, k), mix(a.chl, s.chl, k), mix(a.mean, s.mean, k),
              mix(a.glow, s.glow, k), mix(a.fringe, s.fringe, k));
}

// Defocused tissue, analytic: beyond ~1 plastid radius of blur the plastids are gone and the
// cell mesh's first harmonic is down to exp(-(2 pi b / CW)^2 / 2) < 7%: what remains is the
// tissue tone, a soft per-cell mottle, the costa band and the margin.
LOut layerSoft(Leaf L, vec2 p, vec2 ac, float hw, float b, float e, float aa, vec2 gM, float wBand) {
  LOut o = LOut(vec3(1.0), 0.0, 0.0, 0.0, 1.0, 0.0);
  float dm = min(hw - abs(ac.y), ac.x);
  float dens = densScreen(p);
  // blurred cells: one soft tone per lattice cell (same sheared, warped lattice as the resolved path)
  float s = squeeze(L, hw);
  vec2 X = vec2(ac.x + SHEAR * sab(ac.y * s), ac.y * s);   // (unwarped: at this blur the warp is invisible)
  float mott = nz(X / vec2(CL, CW) + float(L.seed & 63u) * 3.1);
  float fill = 0.42 * p_chloroplasts * mix(0.35, 1.0, dens) * (0.7 + 0.6 * mott);
  vec3 Tt = mix(T_GAP, mix(T_CHL_A, T_CHL_B, 0.4), fill);
  Tt = mix(Tt, pow(T_COSTA, vec3(0.6)), wBand * 0.8);
  o.T = Tt;
  o.chl = fill * 0.75 + 0.1 * wBand;
  o.mean = mix(fill * 0.8, 0.5, wBand);
  if (dm < e + 2.0 * b + 3.0) {                     // near the margin: soft edge, wall, CA, fringe
    float caM = dot(gCAs, gM) / gK;
    vec3 ci = smoothstep(vec3(-e), vec3(e), dm + vec3(caM, 0.0, -caM));
    float wl = 0.6 * lineCov(abs(dm - 1.25) - 1.25, 1.25, b, aa);   // the thick margin wall, blurred
    o.T = mix(mix(vec3(1.0), Tt, ci), T_WALL, wl * (1.0 - ci.g * 0.5));
    o.wall = wl;
    o.chl *= ci.g;
    o.mean *= ci.g;
    o.glow = ci.g;
    o.fringe = exp(-sq((-dm - 0.9 - 0.5 * b) / (0.9 + b))) * 0.9 / (0.9 + b);
  }
  return o;

}

// p: screen px. blurS: base blur in screen px. Works in specimen units inside.
LOut layer(Leaf L, vec2 p, vec2 ac, float hw, float blurS, float aa, float t, bool dark) {
  LOut o = LOut(vec3(1.0), 0.0, 0.0, 0.0, 0.0, 0.0);
  vec2 nrm = vec2(-L.dir.y, L.dir.x);
  float out0 = abs(ac.y) - hw;
  int salt = int(L.seed & 255u);

  // the leaf is tilted in depth, so the thin focal slice cuts it along a band near the margin
  // (the band drifts as the focus breathes); on top, a gentle undulation and a slightly
  // curled margin (|dz| <= .18) make the slice catch it unevenly
  float zl = L.z + L.tilt * (hw - abs(ac.y) - L.band);
  vec2 gM = -sign(ac.y) * nrm;                        // screen direction of increasing dm
  float cBand = costaW(L, max(ac.x, 0.0));
  // far off the focal slice the undulation cannot bring the tissue back into the resolved
  // range: skip it there (it only shifts an already large blur by < 1 px)
  if (abs(gFocus - zl) < 1.1) {
    zl += 0.24 * (nz(ac / 280.0 + float(L.seed & 511u) * 0.71) - 0.5)
        + 0.06 * smoothstep(0.6, 1.0, abs(ac.y) / max(hw, 1.0));
  }
  float dz = abs(gFocus - zl);
  float b = (blurS + gBmax * dz / (1.0 + 1.2 * dz)) / gK;    // specimen units; blur saturates (~12 px) far off focus
  float e = aa + b;
  float wBand = smoothstep(e, -e, abs(ac.y) - cBand); // costa as a soft band

  // analytic defocus above B_LO, resolved path below B_HI (screen px of blur), blended between
  if (b * gK >= B_HI) return layerSoft(L, p, ac, hw, b, e, aa, gM, wBand);
  float caM = dot(gCAs, gM) / gK;                     // lateral CA: R/B edge shift (specimen units)

  // ------------------------------------------------ resolved tissue
  // one Voronoi pass, 2 columns x 3 rows. Exact for the nearest cell: jitter is +-3.6 across
  // columns and +-2 along rows, so column ic-sx is always >= 16.4 away while a cell of column
  // ic is within 16.2. F1 <= F2 <= F3 as a min/max chain; the candidate index rides in the
  // low 3 mantissa bits, and only the cells actually needed are rebuilt afterwards.
  float s = squeeze(L, hw);
  vec2 X = vec2(0.0, ac.y * s);
  X.x = ac.x + SHEAR * sab(X.y);
  X += (nz2(X * vec2(0.5 / CL, 0.5 / CW) + float(L.seed & 255u)) - 0.5) * vec2(CL, CW) * 0.3;
  vec2 g = X / vec2(CL, CW);
  int ic = int(floor(g.x + 0.5));
  int sx = g.x >= float(ic) ? 1 : -1;
  int jc = int(floor(g.y - 0.5 * float(ic & 1) + 0.5));
  highp float d1 = 1e9, d2 = 1e9, d3 = 1e9;
  for (int k = 0; k < 6; k++) {
    ivec2 id = ivec2(k < 3 ? ic : ic + sx, jc - 1 + k - (k < 3 ? 0 : 3));
    vec2 P = cellAt(id, cellRnd(id, salt));
    highp float dd = uintBitsToFloat((floatBitsToUint(dot(P - X, P - X) + 1e-3) & 0xFFFFFFF8u) | uint(k));
    d3 = min(d3, max(d2, dd)); d2 = min(d2, max(d1, dd)); d1 = min(d1, dd);
  }
  int k1 = int(floatBitsToUint(d1) & 7u), k2 = int(floatBitsToUint(d2) & 7u);
  ivec2 mb = ivec2(k1 < 3 ? ic : ic + sx, jc - 1 + k1 - (k1 < 3 ? 0 : 3));
  ivec2 m2 = ivec2(k2 < 3 ? ic : ic + sx, jc - 1 + k2 - (k2 < 3 ? 0 : 3));
  vec4 r1v = cellRnd(mb, salt), r2v = cellRnd(m2, salt);
  vec2 Pb = cellAt(mb, r1v), P2 = cellAt(m2, r2v);
  vec4 hc = cellRnd(mb, salt + 53);                   // per-cell traits
  float cB = cBand * s;                               // costa half-band, lattice units
  int c1 = abs(Pb.y) < cB ? 2 : 1;

  // ------------------------------------------------ margin: smooth outline,
  // scalloped by the marginal cells, occasional single-cell teeth
  float M = hw * s;
  float al = clamp((X.x - Pb.x) / (0.55 * CL), -1.0, 1.0);
  float tooth = hc.w < 0.09 ? 0.38 * (1.0 - abs(al + 0.35)) : 0.0;
  float bulge = CW * (0.13 * (1.0 - al * al) + max(tooth, 0.0)) * step(M - 1.4 * CW, abs(Pb.y)) * step(abs(Pb.y), M + 0.5 * CW)
              * (1.0 - smoothstep(0.8, 3.0, b));
  float dm = min((M + bulge - abs(X.y)) / s, ac.x);  // specimen units inside the leaf edge
  const float HM = 1.25;                             // half-thickness of the margin wall
  vec3 dm3 = dm + vec3(caM, 0.0, -caM);
  float ab = Pb.x - SHEAR * sab(Pb.y);                  // cell centre, leaf frame
  vec2 acb = vec2(ab, Pb.y / s);                        // (the squeeze varies slowly across a cell)
  float dens = densScreen(L.tip + gK * (acb.x * L.dir + acb.y * nrm));
  // what a defocused eye sees of this tissue: its area-average transmission
  vec3 Tavg = mix(T_GAP, mix(T_CHL_A, T_CHL_B, 0.4), 0.42 * p_chloroplasts * mix(0.35, 1.0, dens));
  vec3 ci = smoothstep(vec3(-e), vec3(e), dm3);      // leaf body across a defocused margin
  if (dm < 0.0) {
    vec3 wc = lineCov3(-dm3, HM, b, aa) * 0.6;
    o.T = mix(mix(vec3(1.0), Tavg, ci), T_WALL, wc);
    o.wall = wc.g;
    o.chl = 0.3 * ci.g * p_chloroplasts;
    o.glow = ci.g;
    o.fringe = exp(-sq((-dm - 0.9 - 0.5 * b) / (0.9 + b))) * 0.9 / (0.9 + b);
    { if (b * gK > B_LO) o = mixL(o, layerSoft(L, p, ac, hw, b, e, aa, gM, wBand), b); return o; }
  }

  // ------------------------------------------------ walls: bisector with the 2nd nearest cell,
  // and with the 3rd only near a junction (smin fillet thickens 3-way junctions)
  vec2 n2 = normalize(P2 - Pb);
  float b2 = dot(0.5 * (P2 + Pb) - X, n2);
  int c2 = abs(P2.y) < cB ? 2 : 1;
  float dC = c2 != c1 ? b2 : 1e9;                      // costa/lamina boundary
  float w2 = (c1 == 2 && c2 == 2) ? 1e9 : b2 - HT * (0.6 + 0.8 * fract((r1v.z + r2v.z) * 7.31)) * (c1 != c2 ? 1.4 : 1.0);
  float dW = smin(abs(dm - HM) - HM, w2, 3.2);        // the margin wall joins the cell walls
  vec2 nW = n2;
  // the 3rd bisector is >= (sqrt F3 - sqrt F1) / 2 away: skip it unless it can reach the fillet
  if (sqrt(d3) - sqrt(d1) < 2.0 * (3.2 + 1.3 + dW)) {
    int k3 = int(floatBitsToUint(d3) & 7u);
    ivec2 m3 = ivec2(k3 < 3 ? ic : ic + sx, jc - 1 + k3 - (k3 < 3 ? 0 : 3));
    vec4 r3v = cellRnd(m3, salt);
    vec2 P3 = cellAt(m3, r3v);
    vec2 n3 = normalize(P3 - Pb);
    float b3 = dot(0.5 * (P3 + Pb) - X, n3);
    int c3 = abs(P3.y) < cB ? 2 : 1;
    if (c3 != c1) dC = min(dC, b3);
    float w3 = (c1 == 2 && c3 == 2) ? 1e9 : b3 - HT * (0.6 + 0.8 * fract((r1v.z + r3v.z) * 7.31)) * (c1 != c3 ? 1.4 : 1.0);
    nW = w3 < w2 ? n3 : n2;
    dW = smin(dW, w3, 3.2);
  }
  // screen direction of increasing dW (for CA): -(J^T n) in the leaf frame (lattice shear)
  vec2 gws = dW < abs(dm - HM) - HM - 0.01 ? -(nW.x * L.dir + (SHEAR * sign(X.y) * nW.x + s * nW.y) * nrm)
                                         : gM * -sign(dm - HM);
  float caW = dot(gCAs, gws) / gK;
  float meshK = 1.0 - smoothstep(3.4, B_HI, b * gK);   // mesh melts as the analytic path takes over
  vec3 wc = lineCov3(dW + vec3(caW, 0.0, -caW), HT, b, aa) * meshK;
  float flank = exp(-sq((dW - 0.55 - 0.5 * b) / (0.55 + b))) * 0.55 / (0.55 + b) * gPhase * meshK;
  float wC = smoothstep(0.0, aa, dC) * 0.5;
  wC = c1 == 2 ? 0.5 + wC : 0.5 - wC;               // costa weight: cell-exact in focus ...
  wC = mix(wC, wBand, smoothstep(0.4, 2.5, b));      // ... a soft band when defocused

  // ------------------------------------------------ costa: the resolved band lies near the
  // margin, far from the midrib, so the costa only ever shows as the analytic soft band
  vec3 Tcos = pow(T_COSTA, vec3(0.6));
  float chlC = 0.1;
  // ------------------------------------------------ lamina cell
  vec3 Tlam = vec3(1.0);
  float chlL = 0.0, meanC = 0.0;
  if (wC < 0.999) {
    float tipT = smoothstep(0.03, 0.17, acb.x / L.taper);
    bool filled = hc.x < tipT * (0.2 + 0.8 * dens) + 0.02;   // FM: chlorophyllose vs hyaline cell
    float cover = p_chloroplasts * (0.78 + 0.22 * hc.y) * mix(0.6, 1.0, dens);   // AM: plastid count
    meanC = filled ? cover * 0.62 : 0.0;
    float depth = dW;

    // cyclosis: clustered subset of cells, direction alternating per cell
    float cluster = nz(acb / 170.0 + vec2(float(L.seed & 1023u) * 0.37, 3.1));
    float streams = step(0.32, cluster) * step(hc.z, 0.9);   // most cells stream, in patches

    // gap light: cytoplasm, with the blurred plastids of the far cell face showing through
    float under = nz(X / 5.5 + 60.0 * hc.zw);
    vec3 Tgap = mix(T_GAP, vec3(0.86, 0.9, 0.62), 0.35 * streams);   // streaming: clearer vacuole
    Tgap = mix(Tgap, mix(T_CHL_A, T_GAP, 0.3), min(meanC * (0.3 + 0.3 * under), 0.92) * (1.0 - 0.6 * streams));

    float det = c1 == 2 ? 0.0 : 1.0 - smoothstep(2.8, B_HI, b * gK);   // lens detail fades out across the analytic blend
    float cov = 0.0, shade = 0.5, rimv = 0.0, cen = 0.0;
    vec3 cov3 = vec3(0.0);
    if (filled && det > 0.0) {
      // one parietal ring: five large lenses lining the wall; the whole ring glides together
      vec2 lc = X - Pb;
      const float a = 11.0, bb = 0.5 * CW;
      const float ak = a - HT - (0.3 + RC), bk = bb - HT - (0.3 + RC);
      const float eck = (ak - bk) / (ak + bk);
      const float Nk = 5.0;
      float th = fastAtan(lc.y * ak, lc.x * bk);
      float uu = (th - eck * sin(2.0 * th) * 0.5) / TAU;
      float dir = ((mb.x + mb.y) & 1) == 0 ? 1.0 : -1.0;
      const float Lk = 3.14159 * (ak + bk) * (1.0 + 0.25 * eck * eck);
      // whole revolutions per PERIOD keep the loop seamless; speed in screen px/s
      float rev = floor(p_streaming / gK * PERIOD / Lk + 0.5);
      float ph = rev * Nk * (t / PERIOD) * dir * streams + hc.w * Nk;
      float cvk = cover * (1.0 - 0.2 * streams) + 0.15;
      float us = uu * Nk - ph;
      float s0 = floor(us + 0.5);
      float s1 = s0 + (us > s0 ? 1.0 : -1.0);        // lenses are < 1 slot wide: 2 slots suffice
      float soft = 0.6;                               // lens edges are soft even in focus
      float dep = smoothstep(-0.8, 0.6, depth);
      gRackSign = 0.12;                               // lenses: only a faint bokeh rim
      float wsum = 0.0, rsum = 0.0, csum = 0.0, ssum = 0.0;
      float miss = 1.0;
      for (int o2 = 0; o2 < 2; o2++) {
        float sl = o2 == 0 ? s0 : s1;
        int si = int(mod(sl, Nk));
        vec4 r = cellRnd(mb * ivec2(7, 3) + ivec2(si, 101), salt);
        float uk = (sl + ph + (r.y - 0.5) * 0.16) / Nk;
        float thk = TAU * uk + 0.5 * eck * sin(2.0 * TAU * uk);
        vec2 Pk = vec2(ak * cos(thk), bk * sin(thk)) * (1.0 + (r.z - 0.5) * 0.08);
        vec2 d = lc - Pk;
        float rad = RC * (0.9 + 0.12 * r.w);          // < bk: a lens never reaches across the cell axis
        float sd = length(d) - rad;
        float rm;
        float c = discCov(sd, rad, b + soft, aa, rm) * dep * step(r.x, cvk);
        miss *= 1.0 - clamp(c, 0.0, 1.0);
        wsum += c; ssum += c * r.y * r.y; rsum += c * rm; csum += c * smoothstep(0.0, -0.8 * rad, sd);
      }
      cov = 1.0 - miss;                                 // union of the two lenses
      cov3 = vec3(cov);
      float iw = 1.0 / max(wsum, 1e-3);
      shade = mix(0.5, ssum * iw, min(wsum * 4.0, 1.0)); rimv = rsum * iw * cov; cen = csum * iw * cov;
    }
    float prof = smoothstep(-0.5, 3.5, depth) * (1.0 - 0.3 * smoothstep(3.0, 6.0, depth));
    // defocus: cell-to-cell tone steps melt into the tissue average near the walls
    float melt = smoothstep(-0.5 * b, 0.5 + 2.2 * b, depth) * meshK;
    vec3 Tchl = mix(T_CHL_A, T_CHL_B, shade);
    Tchl = mix(Tchl, Tchl * Tchl * 0.9, 0.18 * rimv * det);      // faint refractive rim
    Tchl *= 1.0 + 0.2 * cen * det * vec3(1.0, 1.0, 1.4);         // the lens focuses light at its centre
    vec3 Tsharp = mix(Tgap, Tchl, clamp(cov3, 0.0, 1.0));
    vec3 Tsoft = mix(Tgap, mix(T_CHL_A, T_CHL_B, 0.4), meanC * prof * 1.1);
    Tlam = filled ? mix(Tsoft, Tsharp, det) : mix(T_TIP, T_GAP, 0.2);
    Tlam = mix(Tavg, Tlam, melt);
  }

  vec3 Tin = mix(Tlam, Tcos, wC);
  Tin *= 1.0 - 0.42 * flank * vec3(1.0, 0.96, 0.8);            // dark refraction line
  Tin = mix(Tin, T_WALL, wc);
  o.T = mix(vec3(1.0), Tin, ci);
  o.glow = ci.g;
  { if (b * gK > B_LO) o = mixL(o, layerSoft(L, p, ac, hw, b, e, aa, gM, wBand), b); return o; }
}

// Periodic Brownian jiggle (px): noise sampled on a circle, 3 octaves.
vec2 brown(float t, vec2 o) {
  float a = TAU * t / PERIOD;
  vec2 c = vec2(cos(a), sin(a));
  return (textureLod(u_noiseTexture, (o + c * 9.0) / 256.0, 0.0).rg - 0.5) * 4.0
       + (textureLod(u_noiseTexture, (o + 73.0 + c * 40.0) / 256.0, 0.0).rg - 0.5) * 2.4
       + (textureLod(u_noiseTexture, (o + 151.0 + c * 110.0) / 256.0, 0.0).rg - 0.5) * 1.3;
}

void main() {
  float pr = max(u_pixelRatio, 0.25);
  vec2 R = u_resolution / pr;
  vec2 q = gl_FragCoord.xy / pr;
  float t = u_time;
  bool dark = u_dark > 0.5;
  float mag = clamp(p_magnification, 0.5, 3.0);
  gK = 3.2 * mag;                                    // screen px per specimen unit

  // ------------------------------------------------ composition
  float sd0 = fract(u_seed * 7.31 + p_slide * 0.6180339);
  float sd1 = fract(sd0 * 13.7 + 0.29);
  uint seedU = uint(p_slide) * 7919u + uint(u_seed * 1000.0);
  vec4 cr = u_contentRect / pr;
  if (cr.z < 1.0 || cr.w < 1.0) cr = vec4(R.x * 0.2, R.y * 0.42, R.x * 0.6, R.y * 0.5);
  float headH = min(cr.w * 0.45, max(150.0, cr.w * 0.36));
  gHeadB = vec2(cr.z, headH) * 0.5;
  gHeadC = vec2(cr.x, cr.y + cr.w - headH) + gHeadB;

  // gentle focus breathing: the upper leaf softens a little and sharpens again, 5 / period
  float wave = 0.5 - 0.5 * cos(TAU * t * 15.0 / PERIOD);   // a 20 s breath
  float f = clamp(p_focusPlane + (p_rackFocus > 0.5 ? 0.42 * wave : 0.0), 0.0, 1.0);
  gBreath = 1.0 + 0.012 * (f - 0.5);                 // focus breathing, tied to the focus
  vec2 drift = vec2(7.0 * sin(TAU * 2.0 * t / PERIOD), 4.5 * sin(TAU * 5.0 * t / PERIOD + 1.3));
  vec2 sp = 0.5 * R + (q - 0.5 * R) / gBreath + drift;   // specimen plane in screen px
  float cond = clamp(p_condenser, 0.0, 1.0);          // stopped down: deeper field, harder edges
  gBmax = mix(15.0, 10.0, cond);                     // screen px of blur per unit of defocus

  // Leaf A: a gently curving, nearly horizontal margin just below the cards; the tissue fills
  // the lower part of the screen and the headline sits on the empty medium above it.
  vec2 m0 = vec2(-0.05 * R.x, cr.y - 105.0 + (sd0 - 0.5) * 24.0);
  vec2 m1 = vec2(1.05 * R.x, cr.y - 65.0 + (sd1 - 0.5) * 24.0);
  vec2 md = normalize(m1 - m0);
  vec2 inw = vec2(md.y, -md.x);                      // into the tissue (downward)
  float WA = 1.05 * max(R.y, 0.55 * R.x);            // half-width (screen px): the midrib stays off-screen
  float TA = 2.6 * WA;
  // the tip lies far beyond m1 so the visible margin is a gentle, nearly straight curve
  vec2 tipA = mix(m0, m1, 0.5) + inw * WA + md * TA * 1.35;
  Leaf A = Leaf(tipA, -md, WA / gK, TA / gK, 0.16 * WA / gK, 0.0, seedU * 3u + 17u, 1.0 / 50.0, 44.0);
  // ------------------------------------------------ field fast path
  // exact outline test (the one layer() starts with): outside it only the medium remains
  vec2 vA = (sp - tipA) / gK;
  vec2 acA = vec2(dot(vA, A.dir), dot(vA, vec2(-A.dir.y, A.dir.x)));
  float reachA = 6.0 + 2.5 * (1.3 + 10.0 + 3.0 + 2.9 * gBmax) / gK;
  float hwA = halfW(A, max(acA.x, 0.0));
  bool nearA = acA.x > -reachA && abs(acA.y) - hwA < reachA;

  vec2 ocn = (q - R * vec2(0.46, 0.55)) / max(R.x, R.y);
  float illum = 1.012 - 0.13 * dot(ocn, ocn);
  // film grain: a fresh field every frame (a hashed whole-texel offset into the app noise; t * 30 steps
  // >= 1 per 20 fps frame), fine 1 px grain plus a little 2 px clumping (bilinear 2x2 mean), ~unit std.
  // It doubles as the output dither, so there is no separate dither fetch.
  uint fr = lb32(uint(floor(t * 30.0)) + 0x51u);
  vec2 gp = floor(gl_FragCoord.xy) + vec2(float(fr & 255u), float((fr >> 8u) & 255u));
  vec2 gn = textureLod(u_noiseTexture, (gp + 0.5) / 256.0, 0.0).rg;
  float gc = textureLod(u_noiseTexture, (gp + vec2(38.0, 92.0)) / 256.0, 0.0).b;
  float film = ((gn.x + gn.y - 1.0) + 1.4 * (gc - 0.5)) * 2.2;

  LOut la = LOut(vec3(1.0), 0.0, 0.0, 0.0, 0.0, 0.0);
  float keep = 1.0;
  if (nearA) {
    float aa = 0.6 / (pr * gK * gBreath);            // one pixel, specimen units
    gCAs = (q - R * vec2(0.46, 0.55)) * CA_K;        // R shifts outward, B inward
    gPhase = mix(0.55, 1.5, cond);
    gFocus = f;
    gRectB = cr.zw * 0.5;
    gRectC = cr.xy + gRectB;
    // near the headline the specimen curls out of the focal slice and fades
    float dH = sdRBox(q - gHeadC, gHeadB, 18.0);
    float zoneBlur = (1.0 - smoothstep(-20.0, 120.0, dH)) * 10.0;
    float blurS = 1.3 + zoneBlur + 12.0 * dot(ocn, ocn);   // + slight overall softness + field curvature
    keep = mix(0.3, 1.0, smoothstep(-10.0, 140.0, dH));
    la = layer(A, sp, acA, hwA, blurS, aa, t, dark);   // la.T stays un-faded: each theme applies `keep` itself
  }

  // ------------------------------------------------ mounting medium
  // Brownian debris: one candidate particle per 150 px cell (texel-hashed), mixed depths
  float pT = 0.0, pHalo = 0.0;
  {
    const float GS = 150.0;
    vec2 cid = floor(sp / GS);
    vec4 r = texelFetch(u_noiseTexture, (ivec2(cid) + ivec2(int(seedU & 127u), 37)) & 255, 0);
    if (r.x < 0.1) {
      vec2 base = (cid + 0.27 + 0.46 * r.yz) * GS;
      float z = r.w < 0.55 ? r.w * 0.5 - 0.1 : r.w * 1.4;   // most sit near the upper leaf plane
      float bz = abs(f - z) * gBmax * 1.1 + 0.3;
      float rad = 1.6 + 2.6 * fract(r.w * 7.3);
      vec2 d = sp - base;
      float lim = rad + bz + 12.0;
      if (dot(d, d) < lim * lim && sdRBox(base - gHeadC, gHeadB + 40.0, 18.0) > 0.0) {
        d -= brown(t, r.yz * 256.0);
        float rm;
        gRackSign = 0.45;
        float c = discCov(length(d) - rad, rad, bz, 0.6 / pr, rm);
        pT = c;
        pHalo = exp(-sq((length(d) - rad - 1.2 - bz) / (1.0 + bz))) * 1.0 / (1.0 + bz);
      }
    }
  }

  // coverslip dust far out of focus: a soft disc with a faint rim + Poisson spot (branchless)
  float dust = 0.0, dustRim = 0.0;
  {
    vec2 c1 = R * vec2(0.07 + 0.1 * sd1, 0.12 + 0.18 * sd0);
    float d1 = length(sp - c1);
    vec2 x = max(1.0 - vec2((d1 - 55.0) / 6.4, d1 / 6.0) * vec2((d1 - 55.0) / 6.4, d1 / 6.0), 0.0);
    x *= x;
    dust = clamp((62.0 - d1) / 8.0, 0.0, 1.0);
    dustRim = x.x + 0.5 * x.y;
  }

  vec3 col;
  if (!dark) {
    // ---------------------------------------------- brightfield
    vec3 T = mix(vec3(1.0), la.T, keep);
    if (la.fringe + pT + pHalo + dust + dustRim > 0.0) {
      // axial chromatic fringe just outside the margin (violet), stronger off-axis
      float lat = clamp(length(ocn) * 2.2, 0.0, 1.0);
      T *= mix(vec3(1.0), vec3(0.93, 0.86, 0.99), la.fringe * keep * (0.55 + 0.45 * lat));
      T *= 1.0 - 0.62 * pT * vec3(1.0, 1.03, 1.1);
      T *= 1.0 + 0.09 * pHalo;
      T *= 1.0 - 0.016 * dust - 0.022 * dustRim * vec3(0.9, 1.0, 1.25);
    }
    // brightfield values stay far above the sRGB toe (T >= ~0.1): the power segment only
    col = 1.055 * pow(max(FIELD * illum * T, 1e-4), vec3(1.0 / 2.4)) - 0.055;
  } else {
    // ---------------------------------------------- night: the same brightfield leaf, dimmed
    // The medium stays near-black; the tissue shows its own brightfield colours at a low lamp
    // level (walls brightest, plastids deep green), so shapes, CA and blur are identical.
    vec3 lit = max(la.T - (1.0 - la.glow), 0.0);      // = coverage x tissue transmission, per channel
    lit *= 1.0 - 0.62 * pT * vec3(1.0, 1.03, 1.1);
    float cv = la.glow * keep;
    float ly = dot(lit, vec3(0.3, 0.55, 0.15));
    lit = max(mix(vec3(ly), lit, 1.7), 0.0);          // richer chlorophyll green at the low lamp level
    col = vec3(0.0042, 0.0042, 0.0056) * illum * (1.0 - cv) + 0.3 * FIELD * illum * lit * vec3(0.85, 1.05, 0.72) * keep;
    col += vec3(0.0055, 0.0052, 0.0075) * la.fringe * keep;         // faint violet fringe past the margin
    col += vec3(0.010, 0.011, 0.010) * (pT * (1.0 - cv) + 0.4 * pHalo) + 0.0012 * dustRim;
    col = 1.055 * pow(max(col, 0.0031308), vec3(1.0 / 2.4)) - 0.055;   // everything sits above the sRGB toe
  }
  // grain strength follows the print tone: strongest in the mid-tones, ~60 % in the bright medium and
  // the dark theme's near-black field (grain = .35: ~3.5/255 std on the tissue, ~2.3/255 on the medium)
  float lum = dot(col, vec3(0.3, 0.55, 0.15));
  float gAmp = max(p_grain * 0.043 * (0.45 + 2.2 * lum * (1.0 - lum)) * (dark ? 0.8 : 1.0), 0.6 / 255.0);
  col += film * gAmp * vec3(1.0, 0.98, 1.03);
  fragColor = vec4(col, 1.0);
}
