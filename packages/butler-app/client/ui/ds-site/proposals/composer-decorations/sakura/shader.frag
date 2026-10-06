// Cherry canopy, painted like the owner's anime references: the tree hangs over the message box
// as soft, cloud-shaped masses of blossom built from many small dabs of pink in four tones (deep
// rose on the shaded underside, rose, mid pink, pale pink-white highlights on top), with
// scalloped edges and a few thin dark branch strokes peeking through. The main mass drapes from
// the top-right corner along the top edge and down the right side; a lighter mass comes in from
// the top-left. Petals fall and flutter from the canopy across the card at varied sizes, spinning.
// No background: premultiplied alpha, the card's own glass shows through.
//
// Readability by composition: the canopy stays in the card's padding frame (top band, right
// band above the toolbar) and the corner zone; it never covers a text line or a control. Over
// the text box, falling petals are fewer and fainter.
//
// Coordinates are CSS px. Every motion term is periodic in T = timePeriod.

const float T = 240.0;
const float TAU = 6.2831853;

vec4 hash(int x, int row) { return texelFetch(u_noiseTexture, ivec2(x & 255, row & 255), 0); }
vec4 hash2(vec2 cell, int row) { return hash(int(mod(cell.x, 64.0)) + 64 * int(mod(cell.y + 8.0, 4.0)), row); }

float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(u_noiseTexture, (i + f + 0.5) / 256.0).b;
}

vec4 over(vec4 dst, vec4 src) { return src + dst * (1.0 - src.a); }

float W;     // card width
float H;     // card height
float D;     // the right band runs down to here (above the toolbar row); 0 on the one-row pill
float AA;    // one device pixel in CSS px
float CX;    // corner zone width
float CY;    // corner zone depth
float ER;    // reach of the right-hand canopy along the top edge
float EL;    // reach of the lighter left-hand canopy
const float BAND_Y = 13.0;   // text starts ~14-15px below the top edge
const float BAND_X = 16.0;   // text lines end 16px before the right edge

// Depth of the canopy's lower edge at a point of the top edge (rc: px from the right edge;
// lc: px from the left edge), before scallops. Thickest at the corner, tapering both ways.
float canopyDepth(float rc, float lc) {
  float corner = (CY - 4.0) * (1.0 - smoothstep(0.0, CX * 1.15, rc));
  float lobes = 3.0 * pow(max(0.0, sin(rc * 0.085 + 2.6 * vn(vec2(rc * 0.03, 4.0)))), 2.0);   // cloud-like scallops
  float right = (mix(BAND_Y - 8.0, 2.0, smoothstep(CX * 0.6, ER, rc)) + lobes * (1.0 - smoothstep(ER * 0.6, ER, rc))) * step(rc, ER);
  float left = (mix(BAND_Y - 8.5, 1.0, smoothstep(0.0, EL, lc)) + 0.7 * lobes) * step(lc, EL);
  float sway = 1.6 * (vn(vec2(rc * 0.06, 2.0)) - 0.5);
  return max(max(corner, right), left) + sway;
}

// Is p (rc, y) inside the canopy? Top band / corner, or the curtain down the right side.
float inside(float rc, float lc, float y) {
  float top = step(y, canopyDepth(rc, lc));
  float curtain = step(rc, BAND_X - 7.0 + 2.0 * vn(vec2(y * 0.08, 7.0))) * step(y, D - 4.0);
  return max(top, curtain);
}

// Light: 0 on the shaded underside (near the lower edge) .. 1 on top (near the card edge).
float lightAt(float rc, float lc, float y) {
  float depth = max(canopyDepth(rc, lc), 1.0);
  float side = rc < BAND_X && y > depth ? 1.0 - y / max(D, 1.0) : 1.0 - y / depth;
  return clamp(side, 0.0, 1.0);
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

// One layer of dabs on a jittered grid: each dab is a small rounded petal-like ellipse at a random
// angle. Dabs exist only where the canopy is; overlapping dabs paint over each other.
vec4 dabs(vec2 px, float cell, float rBias, float lift, int row) {
  vec2 gi = floor(px / cell);
  vec4 col = vec4(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = gi + vec2(float(x), float(y));
      vec4 h = hash2(g, row);
      vec2 ctr = (g + 0.2 + 0.6 * h.rg) * cell;
      float rc = W - ctr.x;
      float y_ = H - ctr.y;
      if (inside(rc, ctr.x, y_) < 0.5) continue;
      float ang = h.b * TAU;
      vec2 q = px - ctr;
      q = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * q;
      float r = cell * rBias * (0.62 + 0.3 * h.a);
      float d = length(q / vec2(1.0, 0.72)) - r;
      float a = 1.0 - smoothstep(-AA, AA, d);
      if (a <= 0.0) continue;
      vec3 c = tone(clamp(lightAt(rc, ctr.x, y_) + lift, 0.0, 1.0), h.g);
      col = over(col, vec4(c * a, a));                                 // dabs layer like paint, no seams
    }
  return col;
}

// Thin dark branch strokes peeking through the mass.
vec4 branches(float rc, float lc, float y) {
  vec4 col = vec4(0.0);
  for (int k = 0; k < 5; k++) {
    vec4 h = hash(k, 151);
    float x0 = k < 4 ? mix(4.0, ER * 0.85, h.r) : -1.0;
    float yb = 2.0 + 4.0 * h.g + 0.035 * (rc - x0) * (h.b - 0.3) + 1.2 * sin(rc * 0.07 + h.a * 6.0);
    float len = 30.0 + 50.0 * h.a;
    float on = step(abs(rc - x0 - len * 0.5), len * 0.5) * step(0.0, x0);
    float th = mix(1.1, 0.5, clamp((rc - x0) / len, 0.0, 1.0));
    float a = (1.0 - smoothstep(th - AA, th + AA, abs(y - yb))) * on;
    col = over(col, vec4(vec3(0.33, 0.24, 0.28) * a, a));
  }
  // one stroke down the right side
  float xb = 3.0 + 0.8 * sin(y * 0.09);
  float a = (1.0 - smoothstep(0.7 - AA, 0.7 + AA, abs(rc - xb))) * step(y, max(D, CY) * 0.8);
  return over(col, vec4(vec3(0.33, 0.24, 0.28) * a, a));
}

// Falling petals: varied sizes, spinning and tumbling, densest under the canopy.
vec4 petals(vec2 px, float rc, float lc, float y, float t, float cell, float size, int fall, float dens, int row, float frame) {
  float vy = float(fall) * cell * 8.0 / T;
  float vx = float(fall / 2 + 1) * cell * 16.0 / T;
  vec2 p = px + vec2(vx * t, vy * t);
  vec2 id = floor(p / cell);
  vec2 f = p - id * cell;
  int hx = int(mod(id.x, 16.0)) + 16 * int(mod(id.y, 8.0));
  vec4 h = hash(hx, row);
  float under = max(1.0 - smoothstep(ER * 0.6, ER * 1.6, rc), 1.0 - smoothstep(EL * 0.5, EL * 1.4, lc));
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
  vec2 px = vec2(gl.x, res.y - gl.y);          // CSS px from the top-left corner, y down
  W = res.x;
  H = res.y;
  float t = u_time;
  AA = 0.8 / u_pixelRatio;
  D = max(0.0, H - 56.0);
  CX = clamp(W * 0.12, 48.0, 92.0);
  CY = p_lush > 0.5 ? min(W < 500.0 ? 15.0 : 22.0, max(H - 28.0, 16.0)) : BAND_Y - 1.0;
  ER = W * 0.5;
  EL = W * 0.2;
  float rc = W - px.x;
  float lc = px.x;
  float y = px.y;

  vec4 col = vec4(0.0);
  if (y < max(max(CY, D), BAND_Y) + 8.0) {
    vec4 back = dabs(vec2(px.x, H - y) + vec2(1.7, -1.3), 4.5, 1.25, -0.25, 31);  // shaded mass behind
    vec4 wood = branches(rc, lc, y);
    vec4 front = dabs(vec2(px.x, H - y), 3.5, 1.1, 0.3, 47);                       // lit dabs on top
    col = over(col, back);
    col = over(col, wood * (back.a > 0.2 || front.a > 0.2 ? 1.0 : 0.0) * 0.85);   // only within the mass
    col = over(col, front);
  }
  // the text box never gets canopy: nothing below the band / outside the corner and curtain
  float frame = max(max(1.0 - smoothstep(BAND_Y - 0.5, BAND_Y + 0.5, y),
    (1.0 - smoothstep(BAND_X - 1.0, BAND_X, rc)) * step(y, D + 4.0)),
    step(length(vec2(rc, y) / vec2(CX, CY)), 1.0));
  col *= frame;
  col = over(col, petals(gl, rc, lc, y, t, 22.0, 1.5, 5, 0.42, 11, frame));
  col = over(col, petals(gl + 9.0, rc, lc, y, t, 31.0, 2.4, 7, 0.34, 23, frame));
  col = over(col, petals(gl + 17.0, rc, lc, y, t, 44.0, 3.4, 9, 0.24, 37, frame));
  fragColor = col;
}
