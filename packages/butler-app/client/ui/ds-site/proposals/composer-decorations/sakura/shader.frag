// Cherry blossom (Somei-yoshino): a blackish branch enters at the top-right corner and runs
// along the top edge and down the right edge, inside the card's padding frame. It is densely set with corymbs of
// 2-5 five-petalled flowers on short pedicels: notched petals, white flushed pale pink toward
// a deep-pink centre, a ring of stamens with pale-yellow anthers; a few buds. Fine petals and
// pollen drift down-left across the card. No background: the output is premultiplied alpha
// and the card's own glass shows through everywhere else.
//
// Layout is in CSS px from the TOP-RIGHT corner (c.x leftward, c.y downward), so the branch
// stays put as the message box grows. Every motion term is periodic in T = timePeriod.

const float T = 240.0;
const float TAU = 6.2831853;
const float PI = 3.14159265;

vec4 hash(int x, int row) { return texelFetch(u_noiseTexture, ivec2(x & 255, row & 255), 0); }

float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(u_noiseTexture, (i + f + 0.5) / 256.0).b;
}

vec4 over(vec4 dst, vec4 src) { return src + dst * (1.0 - src.a); }

float E;    // reach of the branch along the top edge
float D;    // reach down the right edge
float AA;   // one device pixel in CSS px
// The padding frame the art may use: the card's top padding (text starts 12px down when open,
// ~15px at rest) and its right padding (16px) above the toolbar row. Nothing enters the text box.
const float BAND_Y = 12.0;
const float BAND_X = 16.0;

float branchY(float x) { return 1.8 + 0.006 * x + 1.0 * sin(x * 0.052 + 1.0) + 1.4 * (vn(vec2(x * 0.045, 5.0)) - 0.5); }
float branchX(float y) { return 2.2 + 0.02 * y + 0.9 * sin(y * 0.09 + 0.3); }

float segment(vec2 p, vec2 a, vec2 b, out float h) {
  vec2 pa = p - a, ba = b - a;
  h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Bark: blackish grey, rounded by the light from the top-right, horizontal lenticels.
vec4 bark(float dist, float v, float th, float along) {
  float a = 1.0 - smoothstep(th - AA, th + AA, dist);
  if (a <= 0.0) return vec4(0.0);
  float round_ = 0.62 + 0.5 * (1.0 - (v + 0.35) * (v + 0.35));
  vec3 col = vec3(0.17, 0.145, 0.14) * round_;
  float lenticel = smoothstep(0.72, 0.82, vn(vec2(along * 0.55, v * 2.5 + 9.0)));
  col = mix(col, vec3(0.40, 0.36, 0.34), 0.55 * lenticel);
  col += vec3(0.10, 0.08, 0.07) * smoothstep(0.2, -0.9, v);      // sunlit upper side
  return vec4(col * a, a);
}

// One flower. q: pixel relative to the flower centre (corner space). Returns premultiplied.
vec4 flower(vec2 q, float r, vec4 h, vec4 g) {
  // tilt: foreshorten along a random axis so the flowers face every way
  float ta = h.r * PI;
  vec2 axis = vec2(cos(ta), sin(ta));
  vec2 q2 = vec2(dot(q, axis), dot(q, vec2(-axis.y, axis.x)) / (0.55 + 0.45 * g.r));
  float d = length(q2);
  if (d > r * 1.08 + AA) return vec4(0.0);
  if (g.a < 0.14) {                                                  // a bud
    float bd = length(q2 / vec2(0.5, 0.36)) - r * 0.95;
    float ba = 1.0 - smoothstep(-AA * 2.0, AA * 2.0, bd);
    vec3 bc = mix(vec3(0.93, 0.56, 0.66), vec3(0.99, 0.82, 0.87), smoothstep(-r * 0.4, r * 0.3, q2.x));
    return vec4(bc * ba, ba);
  }
  float sector = TAU / 5.0;
  float ang = atan(q2.y, q2.x) + h.g * TAU;
  float u = (mod(ang, sector) - sector * 0.5) / (sector * 0.5);   // -1..1 across a petal
  float edge = r * (0.9 + 0.1 * (1.0 - u * u));
  edge -= r * 0.17 * exp(-u * u / 0.016);                           // the notch at the tip
  edge *= mix(1.0, 0.93, smoothstep(0.8, 1.0, abs(u)));              // broad petals, barely parted
  float a = 1.0 - smoothstep(edge - AA, edge + AA, d);
  if (a <= 0.0) return vec4(0.0);
  float age = g.b;
  vec3 white = vec3(1.0, 0.985, 0.985);
  vec3 flush = mix(vec3(0.985, 0.84, 0.88), vec3(0.96, 0.72, 0.80), age);
  vec3 col = mix(white, flush, smoothstep(0.85 * r, 0.12 * r, d) * (0.6 + 0.4 * age));
  col *= 1.0 - 0.035 * sin(u * 11.0 + h.b * 9.0) * smoothstep(0.25 * r, 0.8 * r, d);   // veins
  col *= 1.0 - 0.11 * smoothstep(0.62, 1.0, abs(u));                 // overlap seams
  col *= 1.0 - 0.12 * smoothstep(edge - 1.4, edge, d);               // translucent rim
  float lit = dot(normalize(q2 + 1e-4), vec2(-0.7071, -0.7071));
  col *= 0.95 + 0.06 * lit * smoothstep(0.1 * r, r, d);
  // centre: deep pink cup, stamens with pale-yellow anthers
  col = mix(col, mix(vec3(0.86, 0.42, 0.52), vec3(0.72, 0.20, 0.32), age), 1.0 - smoothstep(0.17 * r, 0.24 * r, d));
  float fil = smoothstep(0.32, 0.0, abs(fract(ang * 18.0 / TAU) - 0.5)) * step(0.2 * r, d) * step(d, 0.48 * r);
  col = mix(col, vec3(0.97, 0.93, 0.86), 0.45 * fil);
  float anther = smoothstep(0.24, 0.0, abs(fract(ang * 18.0 / TAU + 0.5 * step(0.5, fract(ang * 9.0 / TAU))) - 0.5))
    * (1.0 - smoothstep(0.0, 0.075 * r + AA, abs(d - 0.5 * r)));
  col = mix(col, vec3(0.93, 0.80, 0.42), anther);
  return vec4(col * a, a);
}

// A corymb at `node`: 2-5 flowers on short pedicels, mostly pointing away from the branch.
void corymb(vec2 c, vec2 node, vec2 out_, float size, int id, inout vec4 back, inout vec4 front, inout float shade) {
  if (length(c - node) > size * 2.4 + 8.0) return;
  vec4 hn = hash(id, 101);
  int n = 2 + int(hn.r * 3.999);
  float base = atan(out_.y, out_.x);
  for (int i = 0; i < 5; i++) {
    if (i >= n) break;
    vec4 h = hash(id * 5 + i, 113);
    vec4 g = hash(id * 5 + i, 127);
    float dir = base + (float(i) - float(n - 1) * 0.5) * 0.9 + (h.b - 0.5) * 0.6;
    float len = 2.0 + 4.5 * h.a;
    float r = size * (0.78 + 0.34 * g.g);
    vec2 ctr = node + vec2(cos(dir), sin(dir)) * (len + r * 0.55);
    // keep every flower inside the padding frame: the top band, or the right band above the toolbar
    bool rightBand = ctr.x + r < BAND_X - 0.5 && ctr.y < D;
    if (!rightBand) ctr.y = min(ctr.y, BAND_Y - 0.5 - r - 3.0 * g.b);   // varied, not a ruled line
    vec2 q = c - ctr;
    // soft contact shadow cast down-left onto the glass and the flowers behind
    shade = max(shade, 0.13 * (1.0 - smoothstep(r * 0.4, r * 1.6, length(q - vec2(1.2, 1.8)))));
    // pedicel
    float hh;
    float sd = segment(c, node, ctr, hh);
    float pa = (1.0 - smoothstep(0.35, 0.35 + AA, sd)) * step(hh, 0.92);
    back = over(back, vec4(vec3(0.42, 0.20, 0.19) * pa * 0.9, pa * 0.9));
    vec4 f = flower(q, r, h, g);
    if (h.r < 0.32) back = over(back, f * vec4(vec3(0.93), 1.0));   // behind the branch, a touch darker
    else front = over(front, f);
  }
}

vec4 drift(vec2 px, vec2 c, float t, float cell, float size, int fall, float density, int row, bool pollen) {
  float vy = float(fall) * cell * 8.0 / T;
  float vx = float(fall / 2 + 1) * cell * 16.0 / T;
  vec2 p = px + vec2(vx * t, vy * t);
  vec2 id = floor(p / cell);
  vec2 f = p - id * cell;
  int hx = int(mod(id.x, 16.0)) + 16 * int(mod(id.y, 8.0));
  vec4 h = hash(hx, row);
  float near = mix(0.35, 1.0, 1.0 - smoothstep(E * 0.6, E * 2.6, c.x));
  if (h.a > density * near) return vec4(0.0);
  vec4 g = hash(hx + 128, row);
  float phase = h.b * TAU;
  vec2 ctr = cell * (0.3 + 0.4 * h.rg) + vec2(sin(t * TAU * 36.0 / T + phase), cos(t * TAU * 22.0 / T + phase)) * cell * 0.1;
  vec2 q = f - ctr;
  if (pollen) {
    float a = (1.0 - smoothstep(size * 0.4, size + AA, length(q))) * 0.75;
    return vec4(vec3(0.98, 0.90, 0.62) * a, a);
  }
  float spin = phase + t * TAU * (g.r < 0.5 ? -9.0 : 9.0) / T;
  float tumble = 0.25 + 0.75 * abs(cos(t * TAU * (24.0 + floor(g.g * 10.0)) / T + phase));
  q = mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * q;
  q.x /= tumble;
  float s = size * (0.7 + 0.6 * g.b);
  float notch = length(q - vec2(0.0, s * 1.02)) - s * 0.28;
  float d = max(length(vec2(q.x / 0.68, q.y)) - s, -notch) * tumble;
  float a = (1.0 - smoothstep(-AA * 0.6, AA * 0.6, d)) * 0.9;
  vec3 col = mix(vec3(0.96, 0.80, 0.86), vec3(1.0, 0.97, 0.97), tumble);
  return vec4(col * a, a);
}

void main() {
  vec2 px = gl_FragCoord.xy / u_pixelRatio;
  vec2 res = u_resolution / u_pixelRatio;
  vec2 c = vec2(res.x - px.x, res.y - px.y);
  float t = u_time;
  AA = 0.8 / u_pixelRatio;
  E = clamp(res.x * 0.42, 120.0, 300.0);
  // the right band runs down to just above the toolbar row (47-53px); none on the one-row pill
  D = max(0.0, res.y - 56.0);

  vec4 back = vec4(0.0), front = vec4(0.0), wood = vec4(0.0);
  float shade = 0.0;
  bool inArt = (c.x < E + 14.0 && c.y < BAND_Y + 4.0) || (c.x < BAND_X + 4.0 && c.y < D + 8.0);
  if (inArt) {
    // the branch hugs the top edge (half outside the card) and turns down the right edge
    float yb = branchY(c.x);
    float th = mix(3.6, 0.9, smoothstep(0.0, E, c.x)) * step(c.x, E);
    wood = over(wood, bark(abs(c.y - yb), (c.y - yb) / max(th, 0.5), th, c.x));
    if (D > 0.0) {
      float xb = branchX(c.y);
      float tr = mix(3.0, 0.8, smoothstep(0.0, D, c.y)) * step(c.y, D);
      wood = over(wood, bark(abs(c.x - xb), (c.x - xb) / max(tr, 0.5), tr, c.y + 40.0));
    }
    // corymbs set densely along the branch: denser and larger toward the corner
    float ci = floor(c.x / 5.0);
    for (int k = -3; k <= 3; k++) {
      float i = ci + float(k);
      float nx = (i + 0.5) * 5.0;
      if (i < 0.0 || nx > E) continue;
      vec4 h = hash(int(i), 163);
      float dense = mix(1.0, 0.5, smoothstep(E * 0.45, E, nx));
      if (h.a > dense) continue;
      vec2 node = vec2(nx + (h.r - 0.5) * 3.0, branchY(nx) + (h.g - 0.5) * 2.0);
      vec2 dir = normalize(vec2((h.b - 0.5) * 2.0, h.g < 0.3 ? -0.6 : 0.8));
      corymb(c, node, dir, mix(5.4, 3.8, smoothstep(0.0, E, nx)), 100 + int(i), back, front, shade);
    }
    if (D > 0.0) {
      float cj = floor(c.y / 7.0);
      for (int k = -3; k <= 3; k++) {
        float j = cj + float(k);
        float ny = (j + 0.5) * 7.0;
        if (j < 0.0 || ny > D) continue;
        vec4 h = hash(int(j), 173);
        if (h.a > 0.9) continue;
        vec2 node = vec2(branchX(ny), ny);
        corymb(c, node, normalize(vec2(0.6 + h.b, (h.g - 0.5) * 1.5)), mix(4.6, 3.8, ny / max(D, 1.0)), 200 + int(j), back, front, shade);
      }
    }
  }
  vec4 col = vec4(0.0, 0.0, 0.0, shade * 0.7);                       // contact shadow (premultiplied black)
  col = over(col, back);
  col = over(col, wood);
  col = over(col, front);
  // safety: nothing of the branch enters the text box
  float frame = max(1.0 - smoothstep(BAND_Y - 1.0, BAND_Y, c.y), (1.0 - smoothstep(BAND_X - 1.0, BAND_X, c.x)) * step(c.y, D + 6.0));
  col *= frame;

  // fine petals and pollen drifting down-left across the card
  // inside the text box they fade to a faint shimmer so no glyph ever loses its contrast
  float faint = mix(0.28, 1.0, frame);
  col = over(col, drift(px, c, t, 26.0, 1.3, 5, 0.45, 11, false) * faint);
  col = over(col, drift(px + 11.0, c, t, 38.0, 2.0, 7, 0.32, 23, false) * faint);
  col = over(col, drift(px + 5.0, c, t, 17.0, 0.7, 3, 0.3, 37, true) * faint);
  fragColor = col;
}
