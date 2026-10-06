// Cherry canopy inside the message box, painted like the owner's anime references: soft,
// cloud-shaped masses of blossom built from many small dabs of pink in four tones (deep rose on
// the shaded underside, rose, mid pink, pale pink-white highlights on top), scalloped edges, a few
// thin dark branch strokes peeking through. Petals fall and flutter across the card at varied
// sizes, spinning. No background: premultiplied alpha, the card's own glass shows through.
//
// Composition (fixed size, anchored to the top-right corner and the top edge; it never grows,
// stretches or repeats with the card's height):
//   - along the top padding from the top-right corner (thickest) to 50% of the width, with a
//     lighter mass from the top-left to 20%;
//   - down the right padding (outside the text lines' right end) for a fixed RD px, only while
//     the card is open; the rest of the right side stays clear glass;
//   - a small rounded bulge in the corner itself. Nothing reaches the text lines.
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
float RD;    // fixed depth of the right-padding curtain (0 while the card is the one-row pill)
float ER;    // reach of the right-hand mass along the top edge
float EL;    // reach of the lighter left-hand mass
const float TOP = 12.0;      // the editor content box starts 12px down: the mass stays above it
const float SIDE = 15.0;     // text lines end 16px before the right edge
const float BX = 26.0;       // corner bulge width (from the right edge)
const float BY = 12.0;       // corner bulge depth (stays in the top padding)

float lobes(float x) { return pow(max(0.0, sin(x * 0.085 + 2.6 * vn(vec2(x * 0.03, 4.0)))), 2.0); }

// The mass at p (rc: px from the right edge, lc: from the left edge, y: from the top).
// Returns (inside 0/1, light 0 underside .. 1 top).
vec2 mass(float rc, float lc, float y) {
  float sway = 1.2 * (vn(vec2(rc * 0.06, 2.0)) - 0.5);
  float right = mix(TOP - 1.5, 3.0, smoothstep(BX, ER, rc)) + 2.0 * lobes(rc) * (1.0 - smoothstep(ER * 0.5, ER, rc));
  right = min(right, TOP) * step(rc, ER);
  float left = (mix(TOP - 5.0, 1.0, smoothstep(0.0, EL, lc)) + 1.5 * lobes(lc + 40.0)) * step(lc, EL);
  float depth = max(right, min(left, TOP)) + sway;
  if (y <= depth) return vec2(1.0, clamp(1.0 - y / max(depth, 1.0), 0.0, 1.0));
  float bulge = length(vec2(rc / BX, y / BY)) / (1.0 + 0.1 * lobes(y * 4.0 + rc * 2.0));
  if (bulge < 1.0) return vec2(1.0, clamp(1.0 - y / BY, 0.0, 1.0));
  float width = mix(SIDE - 1.0, SIDE - 6.0, smoothstep(0.0, RD, y)) + 1.5 * (vn(vec2(y * 0.09, 7.0)) - 0.5);
  if (RD > 0.0 && y < RD - 3.0 * smoothstep(SIDE - 6.0, SIDE, rc) && rc < width) return vec2(1.0, clamp(1.0 - y / RD, 0.0, 1.0) * 0.8 + 0.2);
  return vec2(0.0);
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

// One layer of dabs on a jittered grid: small rounded ellipses at random angles, only where the
// mass is. Overlapping dabs paint over each other.
vec4 dabs(vec2 p, float cell, float rBias, float lift, int row) {
  vec2 gi = floor(p / cell);
  vec4 col = vec4(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = gi + vec2(float(x), float(y));
      vec4 h = hash2(g, row);
      vec2 ctr = (g + 0.2 + 0.6 * h.rg) * cell;
      vec2 m = mass(W - ctr.x, ctr.x, ctr.y);
      if (m.x < 0.5) continue;
      float ang = h.b * TAU;
      vec2 q = p - ctr;
      q = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * q;
      float r = cell * rBias * (0.62 + 0.3 * h.a);
      float d = length(q / vec2(1.0, 0.72)) - r;
      float a = 1.0 - smoothstep(-AA, AA, d);
      if (a <= 0.0) continue;
      col = over(col, vec4(tone(clamp(m.y + lift, 0.0, 1.0), h.g) * a, a));
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
  W = res.x;
  H = res.y;
  float t = u_time;
  AA = 0.8 / u_pixelRatio;
  RD = H > 60.0 ? min(H - 56.0, 44.0) : 0.0;          // fixed: never deeper than 44px
  ER = W * 0.5;
  EL = W * 0.2;
  float rc = W - p.x;

  vec4 col = vec4(0.0);
  if (p.y < max(RD, BY) + 10.0) {
    vec4 back = dabs(p + vec2(1.7, 1.3), 4.5, 1.25, -0.25, 31);     // shaded mass behind
    vec4 front = dabs(p, 3.5, 1.1, 0.3, 47);                         // lit dabs on top
    vec4 wood = branches(p) * (back.a > 0.2 || front.a > 0.2 ? 0.85 : 0.0);
    col = over(col, back);
    col = over(col, wood);
    col = over(col, front);
  }
  // hard frame: the top padding, the corner bulge and the right padding down to RD; never the text
  float frame = max(max(1.0 - smoothstep(TOP - 1.0, TOP, p.y),
    step(length(vec2(rc / (BX + 3.0), p.y / BY)), 1.0)),
    (1.0 - smoothstep(SIDE - 0.5, SIDE + 0.5, rc)) * step(p.y, RD + 3.0));
  col *= frame;
  float under = max(1.0 - smoothstep(ER * 0.6, ER * 1.6, rc), 1.0 - smoothstep(EL * 0.5, EL * 1.4, p.x));
  // over the open card's toolbar row petals are only a faint shimmer: controls keep their contrast
  float keepOut = H > 60.0 && p.y > H - 50.0 ? 0.25 : 1.0;
  col = over(col, petals(gl, under, t, 22.0, 1.5, 5, 0.42, 11, frame) * keepOut);
  col = over(col, petals(gl + 9.0, under, t, 31.0, 2.4, 7, 0.34, 23, frame) * keepOut);
  col = over(col, petals(gl + 17.0, under, t, 44.0, 3.4, 9, 0.24, 37, frame) * keepOut);
  fragColor = col;
}
