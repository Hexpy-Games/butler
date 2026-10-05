// Cherry blossom, wisteria habit: a blossoming branch enters at the top-right corner and runs
// along the top and right edges; racemes of tiny florets hang from it, very fine petals drift
// down-left from them. Behind: a sunlit garden far out of focus. Graded like the shoreline
// (filmic tone curve, split tone, restrained saturation, vignette, 24fps grain).
//
// Layout is in CSS px measured from the TOP-RIGHT corner (c.x leftward, c.y downward) so the
// art stays put while the message box grows; the left and lower parts stay calm for the text.
// Every motion term is periodic in T = timePeriod. u_dark is ignored on purpose: the scene is
// the same in light and dark; readability comes from the composer's local scrim.

const float T = 240.0;
const float TAU = 6.2831853;

vec4 hash(int x, int row) { return texelFetch(u_noiseTexture, ivec2(x & 255, row & 255), 0); }

float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(u_noiseTexture, (i + f + 0.5) / 256.0).b;
}

vec3 filmic(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

float E;  // reach of the art along the top edge (px)
float D;  // reach down the right edge (px)

// top branch centre line (distance from the top) at corner-distance x
float topBranch(float x) {
  return 3.5 + 2.2 * sin(x * 0.041 + 1.3) + 2.4 * (vn(vec2(x * 0.05, 7.0)) - 0.5) + 0.018 * x;
}
// right branch centre line (distance from the right edge) at depth y
float rightBranch(float y) {
  return 4.0 + 2.0 * sin(y * 0.09 + 0.4) + 1.6 * (vn(vec2(3.0, y * 0.07)) - 0.5);
}

// One raceme: a pendant cone of florets swinging from `anchor` (corner space).
// Returns premultiplied colour + alpha.
vec4 raceme(vec2 c, vec2 anchor, float L, float w0, float phase, float t, float blur, float seed) {
  float sway = 0.07 * sin(t * TAU * 28.0 / T + phase) + 0.025 * sin(t * TAU * 61.0 / T + phase * 2.3);
  vec2 d = c - anchor;
  float cs = cos(sway), sn = sin(sway);
  vec2 q = vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y);   // q.y: down the raceme, q.x: across
  if (q.y < -3.0 || q.y > L + 3.0 || abs(q.x) > w0 + 3.0) return vec4(0.0);
  float k = clamp(q.y / L, 0.0, 1.0);
  float half_w = w0 * (1.0 - pow(k, 1.5)) * smoothstep(-1.0, 3.0, q.y) + 0.9;
  float env = 1.0 - smoothstep(half_w - 1.2 - blur, half_w + blur, abs(q.x));
  env *= 1.0 - smoothstep(L - 1.5, L + 1.5 + blur, q.y);
  if (env <= 0.0) return vec4(0.0);

  // florets on a jittered grid in raceme space
  const float CELL = 3.3;
  vec2 g = vec2(q.x + 40.0, q.y) / CELL;
  vec2 gi = floor(g);
  float cover = 0.0;
  vec3 fcol = vec3(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 cell = gi + vec2(float(x), float(y));
      vec4 h = hash(int(cell.x) * 7 + int(seed * 97.0), int(cell.y) * 13 + 41);
      if (fract(h.r * 7.31 + h.g * 3.17) < k * 0.6) continue;   // florets thin out toward the tip
      vec2 ctr = (cell + 0.2 + 0.6 * h.rg) * CELL;
      vec2 o = vec2(q.x + 40.0, q.y) - ctr;
      float r = (1.7 + 1.0 * h.b) * mix(1.0, 0.62, k);
      float ang = atan(o.y, o.x) + h.a * TAU;
      float lobe = 0.78 + 0.22 * abs(cos(2.5 * ang));
      float dist = length(o);
      float a = 1.0 - smoothstep(r * lobe - 0.55 - blur, r * lobe + 0.35 + blur, dist);
      if (a <= 0.0) continue;
      // petal colour: white-pink rims, rose centre; lit from the top-right
      vec3 rim = mix(vec3(1.0, 0.91, 0.93), vec3(0.99, 0.76, 0.82), h.g);
      vec3 col = mix(vec3(0.92, 0.42, 0.55), rim, smoothstep(0.12 * r, 0.7 * r, dist));
      float lit = 0.82 + 0.3 * clamp(dot(normalize(o + 1e-3), normalize(vec2(-0.6, -0.8))), -1.0, 1.0);
      col *= lit;
      fcol = mix(fcol, col, a);
      cover = max(cover, a);
    }
  // inner volume: stems and florets in shadow, cooler and darker toward the tip
  vec3 inner = mix(vec3(0.74, 0.40, 0.46), vec3(0.58, 0.34, 0.40), k);
  float core = env * 0.42 * (1.0 - smoothstep(0.0, half_w, abs(q.x)) * 0.6) * (1.0 - k * 0.5);
  vec3 col = mix(inner, fcol, cover);
  float alpha = max(core, cover * env);
  // light falls off down the raceme (ambient occlusion from the florets above)
  col *= mix(1.05, 0.86, k);
  return vec4(col * alpha, alpha);
}

vec4 over(vec4 dst, vec4 src) { return vec4(src.rgb + dst.rgb * (1.0 - src.a), src.a + dst.a * (1.0 - src.a)); }

// fine petals drifting down-left; tiny, sparse, densest under the blossoms
vec4 petals(vec2 px, vec2 c, float t, float cell, float size, int fall, float density, int row) {
  float vy = float(fall) * cell * 8.0 / T;
  float vx = float(fall / 2 + 1) * cell * 16.0 / T;
  vec2 p = px + vec2(vx * t, vy * t);
  vec2 id = floor(p / cell);
  vec2 f = p - id * cell;
  int hx = int(mod(id.x, 16.0)) + 16 * int(mod(id.y, 8.0));
  vec4 h = hash(hx, row);
  float near = 1.0 - smoothstep(E * 0.5, E * 2.0, c.x);
  if (h.a > density * near) return vec4(0.0);
  vec4 g = hash(hx + 128, row);
  float phase = h.b * TAU;
  vec2 ctr = cell * (0.3 + 0.4 * h.rg) + vec2(sin(t * TAU * 36.0 / T + phase) * cell * 0.12, 0.0);
  float spin = phase + t * TAU * (g.r < 0.5 ? -9.0 : 9.0) / T;
  float tumble = 0.25 + 0.75 * abs(cos(t * TAU * (24.0 + floor(g.g * 10.0)) / T + phase));
  vec2 q = f - ctr;
  q = mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * q;
  q.x /= tumble;
  float s = size * (0.7 + 0.6 * g.b);
  float d = (length(vec2(q.x / 0.62, q.y)) - s) * tumble;
  float a = (1.0 - smoothstep(-0.45, 0.45, d)) * 0.92;
  vec3 col = mix(vec3(0.98, 0.84, 0.89), vec3(1.0, 0.97, 0.97), tumble) * (0.9 + 0.15 * tumble);
  return vec4(col * a, a);
}

void main() {
  vec2 px = gl_FragCoord.xy / u_pixelRatio;
  vec2 res = u_resolution / u_pixelRatio;
  vec2 c = vec2(res.x - px.x, res.y - px.y);
  float t = u_time;
  E = clamp(res.x * 0.34, 110.0, 250.0);
  D = min(res.y * 0.8, 74.0);

  // ---- backdrop: clear spring sky over a garden far out of focus
  float v = px.y / res.y;
  vec3 col = mix(vec3(0.56, 0.72, 0.88), vec3(0.36, 0.56, 0.82), smoothstep(0.0, 1.0, v));
  float foliage = vn(px * 0.011 + 3.0) * 0.6 + vn(px * 0.023 + 11.0) * 0.4;
  float low = 1.0 - smoothstep(0.0, 0.7, v);
  col = mix(col, vec3(0.30, 0.48, 0.36), 0.55 * low * smoothstep(0.4, 0.75, foliage));
  col = mix(col, vec3(0.72, 0.80, 0.90), 0.25 * smoothstep(0.55, 0.9, vn(px * 0.006 + 31.0)));   // thin cloud
  // distant blossom trees as large soft bokeh, mostly toward the right
  for (int k = -1; k <= 1; k++) {
    float cx = floor(c.x / 58.0) + float(k);
    vec4 h = hash(int(mod(cx, 64.0)), 151);
    vec2 ctr = vec2((cx + 0.2 + 0.6 * h.r) * 58.0, 8.0 + h.g * max(res.y - 16.0, 8.0));
    float r = 14.0 + h.b * 22.0;
    float d = length(c - ctr) - r;
    float a = (1.0 - smoothstep(-10.0, 1.0, d)) * (0.18 + 0.22 * h.a) * (1.0 - smoothstep(E * 0.8, E * 2.4, c.x));
    float rimLight = smoothstep(-3.0, 0.0, d) * (1.0 - smoothstep(0.0, 1.0, d)) * 0.12;
    col = mix(col, mix(vec3(0.97, 0.84, 0.88), vec3(0.99, 0.95, 0.93), h.a), a) + rimLight * a;
  }
  // sun through the blossoms at the top-right
  float sun = exp(-length(c / vec2(E * 1.1, D * 1.4)) * 2.2);
  col = mix(col, vec3(1.0, 0.95, 0.90), 0.45 * sun);

  // ---- branch along the top edge and down the right edge
  vec4 fg = vec4(0.0);
  {
    float xb = c.x;
    float yb = topBranch(xb);
    float th = mix(5.2, 0.8, smoothstep(0.0, E * 1.15, xb)) * step(xb, E * 1.2);
    float d = abs(c.y - yb) - th;
    float a = (1.0 - smoothstep(-0.6, 0.6, d)) * step(xb, E * 1.2);
    float lit = clamp((yb - c.y) / max(th, 0.5) * 0.5 + 0.5, 0.0, 1.0);
    vec3 bark = mix(vec3(0.17, 0.12, 0.10), vec3(0.36, 0.27, 0.22), lit) * (0.85 + 0.3 * vn(vec2(c.x * 0.6, c.y * 1.5)));
    fg = over(fg, vec4(bark * a, a));
    float xr = rightBranch(c.y);
    float tr = mix(3.2, 0.7, smoothstep(0.0, D, c.y)) * step(c.y, D * 1.05);
    float dr = abs(c.x - xr) - tr;
    float ar = (1.0 - smoothstep(-0.6, 0.6, dr)) * step(c.y, D * 1.05);
    vec3 barkR = mix(vec3(0.17, 0.12, 0.10), vec3(0.34, 0.26, 0.21), clamp((xr - c.x) / max(tr, 0.5) * 0.5 + 0.5, 0.0, 1.0));
    fg = over(fg, vec4(barkR * ar, ar));
  }

  // ---- racemes: a hazier row behind, a crisp row in front
  float maxL = min(res.y * 0.6, 50.0);
  for (int layer = 0; layer < 2; layer++) {
    float S = layer == 0 ? 12.0 : 9.0;
    float off = layer == 0 ? 5.0 : 0.0;
    float blur = layer == 0 ? 0.9 : 0.0;
    int row = layer == 0 ? 171 : 191;
    float ci = floor((c.x - off) / S);
    vec4 acc = vec4(0.0);
    for (int k = -2; k <= 2; k++) {
      float i = ci + float(k);
      if (i < 0.0) continue;
      vec4 h = hash(int(i), row);
      float ax = (i + 0.5 + 0.7 * (h.r - 0.5)) * S + off;
      if (ax > E * 1.05) continue;
      float reach = smoothstep(E * 1.05, E * 0.2, ax);
      if (h.a > 0.25 + 0.75 * reach) continue;
      float L = maxL * mix(0.25, 1.0, reach) * (0.3 + 0.8 * h.g * h.g) * (layer == 0 ? 0.8 : 1.0);
      vec4 r = raceme(c, vec2(ax, topBranch(ax) + 1.0), L, (4.4 + 3.0 * h.b) * (layer == 0 ? 0.85 : 1.0), h.b * TAU, t, blur, h.r + float(layer));
      acc = over(acc, r);
    }
    // racemes off the right-edge branch (shorter)
    float cj = floor(c.y / 11.0);
    for (int k = -3; k <= 1; k++) {
      float j = cj + float(k);
      if (j < 0.0 || j * 11.0 > D) continue;
      vec4 h = hash(int(j) + 40 * layer, 211);
      if (h.a > 0.8) continue;
      float ay = (j + 0.5) * 11.0;
      float L = maxL * 0.55 * (0.5 + 0.5 * h.g) * (1.0 - ay / (D + 20.0));
      vec4 r = raceme(c, vec2(rightBranch(ay) + 2.0 + 3.0 * h.r + (layer == 0 ? 7.0 : 0.0), ay), L, 3.6 + 2.4 * h.b, h.r * TAU + 1.0, t, blur, h.b + 3.0 + float(layer));
      acc = over(acc, r);
    }
    if (layer == 0) acc = vec4(mix(acc.rgb, col * acc.a, 0.3), acc.a * 0.85);   // aerial haze on the back row
    fg = layer == 0 ? over(acc, fg) : over(fg, acc);
  }
  col = fg.rgb + col * (1.0 - fg.a);

  // ---- very fine falling petals
  vec4 p1 = petals(px, c, t, 22.0, 1.1, 5, 0.7, 11);
  vec4 p2 = petals(px + 9.0, c, t, 31.0, 1.6, 7, 0.55, 23);
  vec4 p3 = petals(px + 23.0, c, t, 44.0, 2.2, 9, 0.4, 37);
  col = p1.rgb + col * (1.0 - p1.a);
  col = p2.rgb + col * (1.0 - p2.a);
  col = p3.rgb + col * (1.0 - p3.a);

  // ---- film finish (shoreline's day grade)
  vec3 lw = vec3(0.2126, 0.7152, 0.0722);
  vec3 L = col * col * 1.18;
  L += vec3(0.10, 0.06, 0.05) * sun * sun;                 // halation around the sun
  vec3 y = sqrt(filmic(L));
  float l = dot(y, lw);
  y += vec3(-0.03, 0.01, 0.03) * (1.0 - l) * (1.0 - l) + vec3(0.04, 0.012, -0.03) * l * l;
  y = mix(vec3(l), y, 0.9 * min(0.75 + 0.6 * l, 1.0));
  y = vec3(0.012, 0.018, 0.024) + y * 0.975;
  vec2 vg = (gl_FragCoord.xy / u_resolution - 0.5) * vec2(1.0, 0.6);
  y *= 1.0 - 0.18 * dot(vg, vg);
  float fr = floor(u_time * 24.0);
  ivec2 o = ivec2(int(mod(fr * 71.0, 256.0)), int(mod(fr * 137.0, 256.0)));
  vec4 gn = texelFetch(u_noiseTexture, (ivec2(gl_FragCoord.xy) + o) & 255, 0);
  y += (gn.r + gn.g - 1.0) * 0.026 * (0.35 + 0.65 * (1.0 - abs(2.0 * l - 1.0)));
  fragColor = vec4(clamp(y, 0.0, 1.0), 1.0);
}
