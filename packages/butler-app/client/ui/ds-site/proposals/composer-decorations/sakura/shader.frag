// Cherry blossom: a spring sky behind the message box. Out-of-focus blossom canopy along the
// top edge, three depths of petals tumbling down, a drift of fallen petals along the bottom.
// Laid out in CSS px (gl_FragCoord / u_pixelRatio) so petals keep their size while the card
// grows with the draft. Every motion term is periodic in T = timePeriod, so the u_time wrap
// is seamless. Ignores u_dark on purpose: a scene looks the same in light and dark; the
// composer's local scrim carries readability.

const float T = 240.0;
const float TAU = 6.2831853;

vec4 hash(int x, int row) { return texelFetch(u_noiseTexture, ivec2(x & 255, row & 255), 0); }

float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(u_noiseTexture, (i + f + 0.5) / 256.0).b;
}

// Sakura petal: an egg widening toward its notched outer tip. q in px, s = half length.
float petalSdf(vec2 q, float s) {
  float w = 0.62 + 0.22 * clamp(q.y / s, -1.0, 1.0);
  float d = length(vec2(q.x / w, q.y)) - s;
  float notch = length(q - vec2(0.0, s * 1.04)) - s * 0.3;
  return max(d, -notch);
}

vec3 petalTone(float r, float along) {
  vec3 blush = vec3(0.984, 0.780, 0.835);
  vec3 pink = vec3(0.925, 0.510, 0.635);
  vec3 cream = vec3(1.0, 0.945, 0.957);
  vec3 tip = mix(blush, cream, step(0.62, r));
  return mix(pink, tip, smoothstep(-0.7, 0.5, along));
}

// One depth of falling petals. A cell grid scrolls down (and drifts left) at a speed that
// is a whole number of grid periods per T; each cell may hold one petal that sways, spins
// and tumbles inside its cell. Cell ids repeat every 16 x 8 cells.
vec4 petals(vec2 px, float t, float cell, float size, int fall, float density, float soft, int row) {
  float period = cell * 8.0;
  float vy = float(fall) * period / T;
  float vx = cell * 16.0 / T;
  vec2 p = px + vec2(vx * t, vy * t);
  vec2 id = floor(p / cell);
  vec2 f = p - id * cell;
  int hx = int(mod(id.x, 16.0)) + 16 * int(mod(id.y, 8.0));
  vec4 h = hash(hx, row);
  if (h.a > density) return vec4(0.0);
  vec4 g = hash(hx + 128, row);
  float phase = h.b * TAU;
  float sway = sin(t * TAU * 40.0 / T + phase) * cell * 0.14;
  vec2 c = cell * (0.32 + 0.36 * h.rg) + vec2(sway, 0.0);
  float spin = phase + t * TAU * (g.r < 0.5 ? -6.0 : 6.0) / T + sway * 0.03;
  float tumble = 0.28 + 0.72 * abs(cos(t * TAU * (20.0 + floor(g.g * 12.0)) / T + phase));
  vec2 q = f - c;
  q = mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * q;
  q.x /= tumble;
  float s = size * (0.8 + 0.4 * g.b);
  float d = petalSdf(q, s) * tumble;
  float a = 1.0 - smoothstep(-soft, soft, d);
  // underside shows slightly darker as the petal turns
  vec3 col = petalTone(g.a, q.y / s) * mix(0.93, 1.0, tumble);
  return vec4(col, a);
}

void main() {
  vec2 px = gl_FragCoord.xy / u_pixelRatio;
  vec2 res = u_resolution / u_pixelRatio;
  float t = u_time;
  float v = gl_FragCoord.y / u_resolution.y;

  // sky: clear spring blue at the top, warm blush toward the bottom
  vec3 col = mix(vec3(0.984, 0.890, 0.910), vec3(0.760, 0.855, 0.965), smoothstep(0.05, 1.0, v));
  col += 0.025 * (vn(px * 0.012) - 0.5);

  // out-of-focus canopy: blossom discs hanging from the top edge
  float top = res.y - px.y;
  float haze = smoothstep(52.0, 0.0, top) * (0.55 + 0.45 * vn(vec2(px.x * 0.02, 3.0)));
  col = mix(col, vec3(0.957, 0.700, 0.780), 0.55 * haze);
  for (int k = -1; k <= 1; k++) {
    float cx = floor(px.x / 46.0) + float(k);
    vec4 h = hash(int(mod(cx, 64.0)), 61);
    vec2 center = vec2((cx + 0.15 + 0.7 * h.r) * 46.0, res.y - 2.0 - h.g * 24.0);
    float r = 14.0 + h.b * 18.0;
    float breathe = 1.0 + 0.04 * sin(t * TAU * 10.0 / T + h.a * TAU);
    float d = length(px - center) - r * breathe;
    float a = (1.0 - smoothstep(-8.0, 1.5, d)) * (0.45 + 0.35 * h.a);
    col = mix(col, mix(vec3(0.945, 0.620, 0.720), vec3(0.996, 0.880, 0.910), h.a), a);
  }

  // flower field along the bottom edge: five-petal blossoms nodding in the breeze
  for (int k = -1; k <= 1; k++) {
    float cx = floor(px.x / 26.0) + float(k);
    vec4 h = hash(int(mod(cx, 128.0)), 97);
    if (h.a < 0.25) continue;
    float R = 6.0 + h.b * 4.0;
    vec2 center = vec2((cx + 0.2 + 0.6 * h.r) * 26.0, 3.0 + h.g * 12.0);
    vec2 q = px - center;
    float ang = atan(q.y, q.x) + h.r * TAU + 0.25 * sin(t * TAU * 24.0 / T + h.b * TAU);
    float lobe = 0.55 + 0.45 * pow(abs(cos(2.5 * ang)), 0.6);
    float d = length(q) - R * lobe;
    float a = 1.0 - smoothstep(-0.8, 0.8, d);
    vec3 flower = mix(vec3(0.930, 0.540, 0.660), vec3(1.0, 0.930, 0.945), smoothstep(0.0, R, length(q)) * (0.4 + 0.6 * h.a));
    flower = mix(flower, vec3(0.980, 0.820, 0.520), 1.0 - smoothstep(R * 0.18, R * 0.28, length(q)));
    col = mix(col, flower, a);
  }

  // fallen petals resting along the bottom edge
  {
    float cx = floor(px.x / 13.0);
    vec4 h = hash(int(mod(cx, 128.0)), 83);
    vec2 center = vec2((cx + 0.2 + 0.6 * h.r) * 13.0, 2.5 + h.g * 9.0);
    float ang = h.b * TAU;
    vec2 q = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * (px - center);
    q.y *= 1.0 + h.a;
    float d = petalSdf(q, 3.4 + 1.6 * h.a);
    float a = (1.0 - smoothstep(-0.8, 0.8, d)) * step(0.35, h.a + h.r * 0.4) * 0.85;
    col = mix(col, petalTone(h.r, q.y / 4.0), a);
  }

  // three depths: far (small, soft), middle, near (large, crisp)
  vec4 far = petals(px, t, 30.0, 3.0, 7, 0.6, 1.2, 11);
  col = mix(col, far.rgb, far.a * 0.65);
  vec4 mid = petals(px + 17.0, t, 42.0, 4.6, 8, 0.5, 0.9, 23);
  col = mix(col, mid.rgb, mid.a * 0.88);
  vec4 near = petals(px + 41.0, t, 60.0, 6.6, 9, 0.38, 0.7, 37);
  col = mix(col, near.rgb, near.a);

  fragColor = vec4(col, 1.0);
}
