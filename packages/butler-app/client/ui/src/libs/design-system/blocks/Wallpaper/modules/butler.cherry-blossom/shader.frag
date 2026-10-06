// Cherry canopy inside the message box, painted like the owner's anime references: soft,
// cloud-shaped masses of blossom built from many small dabs of pink (four tones), scalloped
// edges, a few thin dark branch strokes peeking through. Petals fall and flutter across the card
// at varied sizes, spinning. No background: premultiplied alpha, the card's own glass shows through.
//
// Composition, FIXED size (the canopy as drawn on a 375 card, WREF = 349px), never stretched by the
// card's width or height, justified: the left part to the left edge, the right part to the right
// edge; on wider cards the middle of the top edge is empty.
//   - right part: ONE continuous mass whose lower edge is a smooth descending curve: very thin at its
//     inner end (174.5px from the right edge), thickening progressively along the top edge and
//     descending ever faster toward the top-right corner, deepest at the corner (IY = 56px while
//     open, the whole pill at rest; below the top padding only within ~50px of the right edge).
//     No band of constant thickness, no separate corner cluster;
//   - left part: the same logic mirrored and smaller: thin toward its inner end (70px), slightly
//     deeper at the top-left corner, always within the top padding;
//   - lower edges are scalloped and sparser (fringe); shading runs along the depth of the mass.
// Light mode: one palette everywhere. Dark mode: the corner end of the right part is painted in deeper roses,
// blended per dab with a radial falloff from the corner. Nothing else is drawn (no zones, no masks).
//
// Coordinates are CSS px from the card's top-left, y down. Motion is periodic in T = timePeriod.

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

float W;     // card width
float H;     // card height
float AA;    // one device pixel in CSS px
float ER;    // reach of the right-hand mass along the top edge
float EL;    // reach of the lighter left-hand mass
float IX;    // corner radius of the dark-mode deep-rose blend
float IY;    // right-side mass depth (fixed)
float TB;    // bottom of the text area (top of the toolbar row while open)
bool DARK;
bool RIGHT_PART; // evaluating the right part (its own frame): the left part is not drawn there
float TAIL;      // taper length of each part's inner end: 0 on a 375 card, up to 48px with a gap
const float WREF = 349.0;     // the canopy width on a 375px viewport (card 351px inside its 1px border): reference size
const float TOP = 12.0;      // the editor content box starts 12px down
const float SIDE = 15.0;     // text lines end 16px before the right edge


// The lower-edge curves (depth in px below the top edge, before scallops). One exponential
// (log-like) sweep each: no band of constant thickness, no separate corner part.
float rightEnv(float rc) { return 2.0 + max(IY - 2.0, 0.0) * exp(-rc / 29.0); }   // IY at the corner, ~11.6px at 50px, ~2px at the inner end
float leftEnv(float lc) { return 2.5 + 10.0 * exp(-lc / 25.0); }                   // 12.5px at the corner, ~3px at the inner end

// The mass at p (rc: px from the right edge, lc: from the left edge, y: from the top).
// Returns (inside 0/1, light 0 underside .. 1 top, fringe 0 core .. 1 outer edge).
vec3 mass(float rc, float lc, float y) {
  float right = 0.0, left = 0.0, tR = 1.0, tL = 1.0;
  // each part thins out toward its inner end; with a gap (TAIL > 0) the taper runs TAIL px further
  if (rc < ER + TAIL) {
    tR = smoothstep(ER * 0.7, ER + TAIL, rc);
    float sc = 0.86 + 0.22 * vn(vec2(rc * 0.09, 5.0)) + 0.12 * vn(vec2(rc * 0.27, 6.0));
    right = rightEnv(rc) * sc * (1.0 - tR);
  }
  if (!RIGHT_PART && lc < EL + TAIL) {
    tL = smoothstep(EL * 0.6, EL + TAIL, lc);
    float sc = 0.86 + 0.22 * vn(vec2(lc * 0.09, 7.0)) + 0.12 * vn(vec2(lc * 0.27, 8.0));
    left = leftEnv(lc) * sc * (1.0 - tL);
  }
  float depth = max(right, left);
  if (depth < 0.3 || y > depth) return vec3(0.0);
  float s = y / depth;                                         // 0 at the top edge .. 1 at the lower edge
  float taper = right >= left ? tR : tL;
  return vec3(1.0, clamp(1.0 - 0.8 * s, 0.0, 1.0), max(0.6 * smoothstep(0.6, 1.0, s), taper));
}

// Full four-tone range (padding zones).
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

// Dark mode only: the same four-band structure in darker deep roses (luminance <= 0.085), so white
// text keeps >= 4.5:1 where it runs under the corner end of the mass.
vec3 deepTone(float l, float n) {
  float k = clamp(l * 3.2 + (n - 0.5) * 1.1, 0.0, 3.0);
  vec3 a = vec3(0.30, 0.09, 0.18);
  vec3 b = vec3(0.38, 0.13, 0.24);
  vec3 c = vec3(0.46, 0.17, 0.30);
  vec3 d = vec3(0.53, 0.21, 0.35);
  if (k < 1.0) return mix(a, b, step(0.6, k));
  if (k < 2.0) return mix(b, c, step(1.5, k));
  return mix(c, d, step(2.5, k));
}

// Dark mode only: how far a dab belongs to the corner end. Radial from the top-right corner,
// measured at the dab's centre (so every dab is one colour and the change happens dab by dab):
// fully deep across the whole cluster, fading out along the top edge, no straight edge anywhere.
float cornerWeight(vec2 ctr) {
  float o = length(vec2((W - ctr.x) / IX, ctr.y / IY));
  return 1.0 - smoothstep(1.25, 2.4, o);
}

bool inTextZone(vec2 p) { return p.y >= TOP - 1.0 && W - p.x >= SIDE - 1.0 && p.y <= TB; }

// One layer of dabs on a jittered grid: small rounded ellipses at random angles, only where the
// mass is; the outer fringe of the right-side mass gets fewer, smaller dabs. Colour is chosen per
// pixel: the text-zone palette inside the text area, the full range in the padding.
vec4 dabs(vec2 p, vec2 px, float cell, float rBias, float lift, int row) {
  vec2 gi = floor(p / cell);
  vec4 col = vec4(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = gi + vec2(float(x), float(y));
      vec4 h = hash2(g, row);
      vec2 ctr = (g + 0.2 + 0.6 * h.rg) * cell;
      vec3 m = mass(W - ctr.x, ctr.x, ctr.y);
      if (m.x < 0.5) continue;
      if (h.a < m.z * 0.75) continue;
      float ang = h.b * TAU;
      vec2 q = p - ctr;
      q = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * q;
      float r = cell * rBias * (0.62 + 0.3 * h.a) * (1.0 - 0.3 * m.z);
      float d = length(q / vec2(1.0, 0.72)) - r;
      float a = 1.0 - smoothstep(-AA, AA, d);
      if (a <= 0.0) continue;
      float l = clamp(m.y + lift, 0.0, 1.0);
      // the palette changes over the lower half of the top padding, not at a seam
      vec3 c = tone(l, h.g);
      if (DARK) c = mix(c, deepTone(l, h.g), cornerWeight(ctr));
      col = over(col, vec4(c * a, a));
    }
  return col;
}

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Thin dark branch strokes along the top, glimpsed inside the mass.
vec4 branches(vec2 p) {
  vec4 col = vec4(0.0);
  for (int k = 0; k < 5; k++) {
    vec4 h = hash(k, 151);
    vec2 a = vec2(W - 2.0 - 30.0 * h.r, 2.0 + 5.0 * h.g);
    vec2 b = a - vec2(30.0 + 60.0 * h.b, -3.0 * (h.a - 0.4));
    float aa = 1.0 - smoothstep(0.7 - AA, 0.7 + AA, segment(p, a, b));
    col = over(col, vec4(vec3(0.33, 0.24, 0.28) * aa, aa));
  }
  return col;
}

// Falling petals: varied sizes, spinning and tumbling, densest under the canopy (gl space).
// Over the text area: a quarter as many, 45% opacity, in the text-zone palette.
vec4 petals(vec2 gl, vec2 p, float under, float t, float cell, float size, int fall, float dens, int row) {
  bool bar = H > 60.0 && p.y > TB;                      // the open card's toolbar row
  bool tz = inTextZone(p) || bar;
  float vy = float(fall) * cell * 8.0 / T;
  float vx = float(fall / 2 + 1) * cell * 16.0 / T;
  vec2 pp = gl + vec2(vx * t, vy * t);
  vec2 id = floor(pp / cell);
  vec2 f = pp - id * cell;
  int hx = int(mod(id.x, 16.0)) + 16 * int(mod(id.y, 8.0));
  vec4 h = hash(hx, row);
  if (h.a > dens * mix(0.3, 1.0, under) * (tz ? 0.25 : 1.0)) return vec4(0.0);
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
  float a = (1.0 - smoothstep(-AA * 0.6, AA * 0.6, d)) * (bar ? 0.15 : tz ? 0.3 : 0.92);   // faint over text
  vec3 col = mix(vec3(0.93, 0.62, 0.74), vec3(0.99, 0.86, 0.90), tumble);
  return vec4(col * a, a);
}

void main() {
  vec2 res = u_resolution / u_pixelRatio;
  vec2 gl = gl_FragCoord.xy / u_pixelRatio;
  vec2 p = vec2(gl.x, res.y - gl.y);
  W = res.x;
  H = res.y;
  DARK = u_dark > 0.5;
  float t = u_time;
  AA = 0.8 / u_pixelRatio;
  ER = WREF * 0.5;                                      // fixed: the 375 reference, never stretched
  EL = WREF * 0.2;
  IX = 50.0;                                            // fixed: tucked into the corner
  TB = H > 60.0 ? H - 50.0 : H;                         // the toolbar row starts ~47-53px from the bottom
  IY = min(56.0, TB);                                   // fixed depth; never deeper than 56px
  float rc = W - p.x;

  vec4 col = vec4(0.0);
  if (p.y < IY + 10.0) {
    // Justified: the left part stays where it is; the right part (one continuous mass into the corner)
    // is drawn exactly as on a 375 card and anchored to the right edge. The split sits in the middle
    // of the empty gap between them; on a 375 card the shift is 0, so it renders unchanged.
    float split = 0.5 * (EL + (W - ER));
    vec2 q = p;
    TAIL = clamp(W - WREF, 0.0, 48.0);
    RIGHT_PART = p.x >= split;
    if (RIGHT_PART) { q.x -= W - WREF; W = WREF; }
    vec4 back = dabs(q + vec2(1.7, 1.3), q, 4.5, 1.25, -0.25, 31);  // shaded mass behind
    vec4 front = dabs(q, q, 3.5, 1.1, 0.3, 47);                      // lit dabs on top
    vec4 wood = branches(q) * (back.a > 0.2 || front.a > 0.2 ? 0.85 : 0.0) * (inTextZone(q) ? 0.0 : 1.0);
    W = res.x;
    col = over(col, back);
    col = over(col, wood);
    col = over(col, front);
  }
  // soft frame following the same curves (dab overspill only), never a straight edge
  float envR = rc < ER + TAIL ? rightEnv(rc) * (1.0 - smoothstep(ER * 0.7, ER + TAIL, rc)) : 0.0;
  float envL = p.x < EL + TAIL ? leftEnv(p.x) * (1.0 - smoothstep(EL * 0.6, EL + TAIL, p.x)) : 0.0;
  float lim = min(max(envR, envL) * 1.1 + 5.0, IY + 3.0);
  float frame = 1.0 - smoothstep(lim - 2.0, lim, p.y);
  col *= frame;
  float under = max(1.0 - smoothstep(ER * 0.6, ER * 1.6, rc), 1.0 - smoothstep(EL * 0.5, EL * 1.4, p.x));
  col = over(col, petals(gl, p, under, t, 22.0, 1.5, 5, 0.42, 11));
  col = over(col, petals(gl + 9.0, p, under, t, 31.0, 2.4, 7, 0.34, 23));
  col = over(col, petals(gl + 17.0, p, under, t, 44.0, 3.4, 9, 0.24, 37));
  fragColor = col;
}
