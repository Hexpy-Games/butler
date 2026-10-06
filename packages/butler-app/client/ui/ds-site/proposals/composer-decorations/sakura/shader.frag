// Cherry canopy, painted like the owner's anime references: the tree hangs over the message box
// as soft, cloud-shaped masses of blossom built from many small dabs of pink in four tones (deep
// rose on the shaded underside, rose, mid pink, pale pink-white highlights on top), with
// scalloped edges and a few thin dark branch strokes peeking through. Petals fall and flutter
// from the canopy across the card at varied sizes, spinning. No background: premultiplied
// alpha, the card's own glass (or the page) shows through.
//
// p_layout (where the canopy may be):
//   0 corner  (baseline): the card's padding frame plus a deeper top-right corner;
//   1 intrude: masses also fill the empty right ~33% of the card (25% on phones) above the
//              toolbar row; their outer parts are paler and sparser, long drafts may run under them;
//   2 spill:   the card keeps a light fringe; the big masses drape OUTSIDE, above the card
//              (drawn by a second canvas with p_part 1), wrapping around the top corners;
//   3 frame:   padding frame only.
// p_part: 0 the canvas inside the card; 1 the canvas outside, above the card (spill only):
//   it spans the card width + 20px each side and from SPILL px above the card to 34px into it
//   (into the card body only its top 5px; the rest is the page outside the rounded corners).
//
// Coordinates are CSS px, y down. Every motion term is periodic in T = timePeriod.

const float T = 240.0;
const float TAU = 6.2831853;

vec4 hash(int x, int row) { return texelFetch(u_noiseTexture, ivec2(x & 255, row & 255), 0); }
vec4 hash2(vec2 cell, int row) { return hash(int(mod(cell.x, 64.0)) + 64 * int(mod(cell.y + 64.0, 4.0)), row); }

float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(u_noiseTexture, (i + f + 0.5) / 256.0).b;
}

vec4 over(vec4 dst, vec4 src) { return src + dst * (1.0 - src.a); }

float WC;    // card width
float HC;    // card height (card part) / 0 (outside part)
float OX;    // card's left edge in canvas px
float OY;    // card's top edge in canvas px
float AA;    // one device pixel in CSS px
float D;     // the right band runs down to here (above the toolbar row); 0 on the one-row pill
float CX;    // corner zone width
float CY;    // corner zone depth
float ER;    // reach of the right-hand canopy along the top edge
float EL;    // reach of the lighter left-hand canopy
float IX;    // intrude zone width
float IY;    // intrude zone depth
float SPILL; // height of the spill above the card
int LAYOUT;
int PART;
const float BAND_Y = 13.0;   // text starts ~14-15px below the top edge
const float BAND_X = 16.0;   // text lines end 16px before the right edge

float lobes(float x) { return 3.0 * pow(max(0.0, sin(x * 0.085 + 2.6 * vn(vec2(x * 0.03, 4.0)))), 2.0); }

// The mass at card-relative point q (x from the card's left edge, y from its top edge; y < 0 is
// above the card). Returns (inside 0/1, light 0 underside .. 1 top, outer 0 core .. 1 fringe).
vec3 mass(vec2 q) {
  float rc = WC - q.x;
  float lc = q.x;
  float y = q.y;
  if (PART == 1) {
    // spill: masses above the card, heaviest at the top-right, lighter at the top-left, a low
    // swag between; the lower edge rests 9px into the card and wraps down outside the corners
    // cloud-like crowns: a few big rounded bumps, tallest over the right corner
    float S = SPILL - 8.0;
    float crownR = 1.0 - smoothstep(0.0, WC * 0.36, rc + 6.0 * sin(rc * 0.05));
    float crownL = 1.0 - smoothstep(0.0, WC * 0.2, lc + 5.0 * sin(lc * 0.06));
    float bumps = 0.78 + 0.22 * sin(q.x * 0.11 + 1.3 * vn(vec2(q.x * 0.02, 5.0)) * TAU);
    float hR = S * pow(crownR, 0.55) * bumps;
    float hL = 0.7 * S * pow(crownL, 0.6) * bumps;
    float hM = 2.0 + 1.2 * lobes(lc);                               // a light swag between
    float height = max(max(hR, hL), hM);
    // around the rounded top corners the canopy hugs the card's curve (radius RAD): it may fill
    // the page area outside the curve, down to RAD; over the card body only its top 5px
    float outR = max(q.x - WC, 0.0), outL = max(-q.x, 0.0);
    float RAD = 28.0;
    float gapR = rc < RAD ? RAD - sqrt(max(0.0, RAD * RAD - (RAD - rc) * (RAD - rc))) : 0.0;
    float gapL = lc < RAD ? RAD - sqrt(max(0.0, RAD * RAD - (RAD - lc) * (RAD - lc))) : 0.0;
    float edge = outR + outL > 0.0 ? RAD : max(gapR * step(0.5, crownR), gapL * step(0.5, crownL));
    float sideFade = (1.0 - smoothstep(4.0, 16.0, outR)) * (1.0 - smoothstep(3.0, 14.0, outL));
    float bottom = 5.0 + edge * sideFade * (outR + outL > 0.0 ? step(0.5, max(crownR, crownL)) : 1.0)
      + 1.5 * (vn(vec2(q.x * 0.07, 9.0)) - 0.5);
    height *= sideFade;
    float top = -height;
    float inside = step(top, y) * step(y, bottom) * step(outR, 16.0) * step(outL, 14.0);
    return vec3(inside, clamp((bottom - y) / max(bottom - top, 1.0), 0.0, 1.0), 0.0);
  }
  float sway = 1.6 * (vn(vec2(rc * 0.06, 2.0)) - 0.5);
  float spillFringe = LAYOUT == 2 ? 3.0 : 0.0;           // spill: the card keeps a lighter fringe
  float corner = LAYOUT == 0 || LAYOUT == 1 ? (CY - 4.0) * (1.0 - smoothstep(0.0, CX * 1.15, rc)) : 0.0;
  float right = (mix(BAND_Y - 8.0 - spillFringe, 2.0, smoothstep(CX * 0.6, ER, rc)) + lobes(rc) * (1.0 - smoothstep(ER * 0.6, ER, rc))) * step(rc, ER);
  float left = (mix(BAND_Y - 8.5 - spillFringe, 1.0, smoothstep(0.0, EL, lc)) + 0.7 * lobes(rc)) * step(lc, EL);
  float depth = max(max(corner, right), left) + sway;
  float top = step(y, depth);
  float curtain = LAYOUT == 2 ? 0.0 : step(rc, BAND_X - 7.0 + 2.0 * vn(vec2(y * 0.08, 7.0))) * step(y, D - 4.0);
  float light = rc < BAND_X && y > depth ? 1.0 - y / max(D, 1.0) : 1.0 - y / max(depth, 1.0);
  vec3 m = vec3(max(top, curtain), clamp(light, 0.0, 1.0), 0.0);
  if (LAYOUT == 1) {
    // intrude: a quarter-ellipse of canopy over the empty right side, above the toolbar row
    float wob = 1.0 + 0.16 * (vn(vec2(atan(y, rc) * 4.0, 3.0)) - 0.5) + 0.06 * lobes(y * 3.0 + rc);
    float o = length(vec2(rc / IX, y / IY)) / wob;
    if (o < 1.0 && m.x < 0.5) m = vec3(1.0, clamp(1.0 - y / IY + 0.25 * (1.0 - o), 0.0, 1.0), smoothstep(0.35, 1.0, o));
  }
  return m;
}

vec3 tone(float l, float n) {
  float k = clamp(l * 3.2 + (n - 0.5) * 1.1, 0.0, 3.0);
  vec3 deep = vec3(0.84, 0.43, 0.58);
  vec3 rose = vec3(0.92, 0.57, 0.70);
  vec3 mid = vec3(0.97, 0.73, 0.82);
  vec3 pale = vec3(1.0, 0.91, 0.94);
  if (k < 1.0) return mix(deep, rose, step(0.6, k));
  if (k < 2.0) return mix(rose, mid, step(1.5, k));
  return mix(mid, pale, step(2.5, k));
}

// One layer of dabs on a jittered grid (canvas px, y down): small rounded ellipses at random
// angles, only where the canopy is. The outer fringe of the intrude mass gets fewer, smaller,
// paler dabs. Overlapping dabs paint over each other.
vec4 dabs(vec2 p, float cell, float rBias, float lift, int row) {
  vec2 gi = floor(p / cell);
  vec4 col = vec4(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = gi + vec2(float(x), float(y));
      vec4 h = hash2(g, row);
      vec2 ctr = (g + 0.2 + 0.6 * h.rg) * cell;
      vec3 m = mass(ctr - vec2(OX, OY));
      if (m.x < 0.5) continue;
      if (h.a < m.z * 0.8) continue;                                  // sparser toward the fringe
      float ang = h.b * TAU;
      vec2 q = p - ctr;
      q = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * q;
      float r = cell * rBias * (0.62 + 0.3 * h.a) * (1.0 - 0.35 * m.z);
      float d = length(q / vec2(1.0, 0.72)) - r;
      float a = 1.0 - smoothstep(-AA, AA, d);
      if (a <= 0.0) continue;
      vec3 c = tone(clamp(m.y + lift + 0.9 * m.z, 0.0, 1.0), h.g);
      col = over(col, vec4(c * a, a));
    }
  return col;
}

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Thin dark branch strokes peeking through the mass (card-relative coordinates).
vec4 branches(vec2 q) {
  vec4 col = vec4(0.0);
  vec3 ink = vec3(0.33, 0.24, 0.28);
  for (int k = 0; k < 5; k++) {
    vec4 h = hash(k, 151);
    vec2 a, b;
    if (PART == 1) {
      a = vec2(WC + 14.0 - 6.0 * h.r, -SPILL * (0.5 + 0.5 * h.g));
      b = vec2(WC - WC * (0.12 + 0.3 * h.b), -2.0 - 10.0 * h.a);
    } else {
      a = vec2(WC - 2.0 - 30.0 * h.r, 2.0 + 5.0 * h.g);
      b = a - vec2(30.0 + 60.0 * h.b, -3.0 * (h.a - 0.4));
    }
    float th = PART == 1 ? 1.2 : 0.7;
    float aa = 1.0 - smoothstep(th - AA, th + AA, segment(q, a, b));
    col = over(col, vec4(ink * aa, aa));
  }
  return col;
}

// Falling petals: varied sizes, spinning and tumbling, densest under the canopy (glFrag space).
vec4 petals(vec2 gl, float under, float t, float cell, float size, int fall, float dens, int row, float frame) {
  float vy = float(fall) * cell * 8.0 / T;
  float vx = float(fall / 2 + 1) * cell * 16.0 / T;
  vec2 p = gl + vec2(vx * t, vy * t);
  vec2 id = floor(p / cell);
  vec2 f = p - id * cell;
  int hx = int(mod(id.x, 16.0)) + 16 * int(mod(id.y, 8.0));
  vec4 h = hash(hx, row);
  if (h.a > dens * mix(0.3, 1.0, under) * mix(0.33, 1.0, frame)) return vec4(0.0);
  float keep = mix(0.55, 1.0, frame);
  vec4 g = hash(hx + 128, row);
  float phase = h.b * TAU;
  vec2 ctr = cell * (0.3 + 0.4 * h.rg) + vec2(sin(t * TAU * 36.0 / T + phase), cos(t * TAU * 22.0 / T + phase)) * cell * 0.12;
  vec2 q = f - ctr;
  float spin = phase + t * TAU * (g.r < 0.5 ? -9.0 : 9.0) / T;
  float tumble = 0.25 + 0.75 * abs(cos(t * TAU * (24.0 + floor(g.g * 10.0)) / T + phase));
  q = mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * q;
  q.x /= tumble;
  float s = size * (0.6 + 0.8 * g.b);
  float notch = length(q - vec2(0.0, s * 1.02)) - s * 0.28;
  float d = max(length(vec2(q.x / 0.62, q.y)) - s, -notch) * tumble;
  float a = (1.0 - smoothstep(-AA * 0.6, AA * 0.6, d)) * 0.92 * keep;
  vec3 col = mix(vec3(0.93, 0.62, 0.74), vec3(0.99, 0.86, 0.90), tumble);
  return vec4(col * a, a);
}

void main() {
  vec2 res = u_resolution / u_pixelRatio;
  vec2 gl = gl_FragCoord.xy / u_pixelRatio;
  vec2 p = vec2(gl.x, res.y - gl.y);
  LAYOUT = p_layout;
  PART = p_part;
  float t = u_time;
  AA = 0.8 / u_pixelRatio;
  if (PART == 1) {
    OX = 20.0;
    WC = res.x - 40.0;
    SPILL = res.y - 34.0;
    OY = SPILL;
    HC = 0.0;
  } else {
    OX = 0.0;
    OY = 0.0;
    WC = res.x;
    HC = res.y;
    SPILL = 0.0;
  }
  bool phone = WC < 500.0;
  D = max(0.0, HC - 56.0);
  CX = clamp(WC * 0.12, 48.0, 92.0);
  CY = phone ? 15.0 : min(22.0, max(HC - 28.0, 16.0));
  ER = WC * 0.5;
  EL = WC * 0.2;
  IX = WC * (phone ? 0.25 : 0.34);
  IY = HC > 60.0 ? HC - 50.0 : HC;                    // above the toolbar row when open
  vec2 q = p - vec2(OX, OY);
  float rc = WC - q.x;

  vec4 col = vec4(0.0);
  vec4 back = dabs(p + vec2(1.7, 1.3), 4.5, 1.25, -0.25, 31);       // shaded mass behind
  vec4 front = dabs(p, 3.5, 1.1, 0.3, 47);                           // lit dabs on top
  vec4 wood = branches(q) * (back.a > 0.2 || front.a > 0.2 ? 0.85 : 0.0);   // only within the mass
  col = over(col, back);
  col = over(col, wood);
  col = over(col, front);
  float frame = 1.0;
  if (PART == 0) {
    // corner / frame / spill: nothing below the band except the corner and the right curtain.
    // intrude: the right zone is allowed too (its fringe is pale and sparse).
    frame = max(max(1.0 - smoothstep(BAND_Y - 0.5, BAND_Y + 0.5, q.y),
      (1.0 - smoothstep(BAND_X - 1.0, BAND_X, rc)) * step(q.y, D + 4.0) * (LAYOUT == 2 ? 0.0 : 1.0)),
      (LAYOUT == 0 || LAYOUT == 1 ? step(length(vec2(rc, q.y) / vec2(CX, CY)), 1.0) : 0.0));
    if (LAYOUT == 1) frame = max(frame, step(length(vec2(rc / (IX * 1.2), q.y / IY)), 1.0) * step(q.y, IY + 2.0));
    col *= frame;
  }
  float under = PART == 1 ? 1.0 : max(1.0 - smoothstep(ER * 0.6, ER * 1.6, rc), 1.0 - smoothstep(EL * 0.5, EL * 1.4, q.x));
  if (LAYOUT == 2 && PART == 0) under = 0.8;
  // the outside canvas overlaps the card's top 34px: its petals stay off the card body (the card
  // canvas draws those, fewer and fainter over the text)
  if (PART == 1) frame = 1.0 - step(0.0, q.x) * step(q.x, WC) * step(4.0, q.y);
  float keepOut = PART == 1 ? frame : 1.0;
  // over the toolbar row (open card) petals are only a faint shimmer: controls keep their contrast
  if (PART == 0 && HC > 60.0 && q.y > HC - 50.0) keepOut = 0.25;
  col = over(col, petals(gl, under, t, 22.0, 1.5, 5, 0.42, 11, frame) * keepOut);
  col = over(col, petals(gl + 9.0, under, t, 31.0, 2.4, 7, 0.34, 23, frame) * keepOut);
  col = over(col, petals(gl + 17.0, under, t, 44.0, 3.4, 9, 0.24, 37, frame) * keepOut);
  fragColor = col;
}
