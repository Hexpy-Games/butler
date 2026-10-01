// Riso Flow (butler.riso-flow) — a risograph print seen through a loupe.
// Three spot-colour plates, each a soft sheet of a fan opening from its own focal point below the
// bottom edge (lower left, left of centre, centre), are screened with their own halftone angle and overprinted (multiply on light stock,
// opaque-ish inks on dark stock). The sheets sway and their strengths drift, so dots grow and
// shrink and the overprint colours move. Riso traits: dot gain and ragged dots, mottled ink,
// starvation specks, plate misregistration, paper tooth and fibres.
const float TAU = 6.2831853;

// smooth 4-channel value noise (C1 via hardware bilinear); x in texels
vec4 nz(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return texture(u_noiseTexture, (i + f + 0.5) / 256.0);
}
// raw bilinear noise, for grain that needs no smoothness
vec4 nr(vec2 x) { return texture(u_noiseTexture, x / 256.0); }

// atan2 on the upper half-plane (the focal point sits below the canvas); |err| < 1e-5
float atanUp(float y, float x) {
  float ax = abs(x), a = min(ax, y) / max(max(ax, y), 1e-6), s = a * a;
  float t = ((-0.0464965 * s + 0.1593142) * s - 0.3276228) * s * a + a;
  t = y > ax ? 1.5707963 - t : t;
  return x < 0.0 ? 3.1415927 - t : t;
}
// parabolic sine, period 2π (|err| < 0.06)
vec3 wav(vec3 x) { vec3 t = fract(x * 0.1591549) * 2.0 - 1.0; return -4.0 * t * (1.0 - abs(t)); }

// amplitude-modulated round dot: area ≈ d, merging into a solid; rag roughens the edge
float screenDot(vec2 q, float d, float rag, float aa, vec2 jit) {
  vec2 g = fract(q) - 0.5 + jit;
  float r = sqrt(d * 0.3183) + 0.17 * smoothstep(0.5, 1.0, d) + 0.02;   // + dot gain
  return (1.0 - smoothstep(r - aa, r + aa, length(g) + rag)) * smoothstep(0.01, 0.05, d);
}

// real riso inks (stencil.wiki hex): A, B, C
void inkSet(int k, out vec3 a, out vec3 b, out vec3 c) {
  if (k == 1) { a = vec3(1.0, 0.424, 0.184); b = vec3(0.239, 0.333, 0.533); c = vec3(1.0, 0.710, 0.067); }      // Orange, Federal Blue, Sunflower
  else if (k == 2) { a = vec3(1.0, 0.282, 0.690); b = vec3(0.0, 0.514, 0.541); c = vec3(1.0, 0.710, 0.067); } // Fluo Pink, Teal, Sunflower
  else if (k == 3) { a = vec3(1.0, 0.282, 0.690); b = vec3(0.369, 0.784, 0.898); c = vec3(1.0, 0.910, 0.0); } // Fluo Pink, Aqua, Yellow
  else { a = vec3(1.0, 0.282, 0.690); b = vec3(0.196, 0.333, 0.643); c = vec3(1.0, 0.910, 0.0); }             // Fluo Pink, Medium Blue, Yellow
}

void main() {
  vec2 res = u_resolution, fc = gl_FragCoord.xy;
  float pr = max(u_pixelRatio, 0.25);
  bool portrait = res.x < res.y;
  vec2 p = (fc - 0.5 * res) / res.y;

  // one loop per timePeriod / flow; flow is an integer, so u_time wrapping is seamless
  float ph = TAU * u_time / 240.0 * floor(p_flow + 0.5);
  vec2 cyc = vec2(cos(ph), sin(ph));

  // ---- composition: three sheets fanning out from focal points spread along below the bottom
  // edge (plate C lower left, A left of centre, B at centre), curling right as they rise ----
  vec3 Fx = portrait ? vec3(-0.07, 0.06, -0.16) : vec3(-0.4, -0.12, -0.37 * res.x / res.y);
  vec3 Fy = portrait ? vec3(-0.63, -0.64, -0.62) : vec3(-0.65, -0.66, -0.64);
  vec4 w = nz(p * 1.05 + cyc * 0.7 + vec2(17.0, 3.0) + u_seed * 40.0);
  vec3 dx = p.x - Fx, dy = p.y - Fy;
  vec3 r = sqrt(dx * dx + dy * dy);
  vec3 th = vec3(atanUp(dy.x, dx.x), atanUp(dy.y, dx.y), atanUp(dy.z, dx.z)) + (w.x - 0.5) * 0.2;   // 0 = right, π/2 = up

  // crest angle of each plate's sheet: base, curl with radius, a sway travelling outward
  vec3 crest = vec3(0.98, 0.76, 1.1) + (portrait ? 0.2 : 0.0) - 0.26 * r
             + 0.1 * wav(vec3(4.2, 3.6, 5.0) * r - vec3(5.0, 4.0, 5.0) * ph + vec3(0.0, 2.1, 4.2))
             + 0.05 * wav(vec3(1.0, -1.0, 1.0) * ph + vec3(1.3, 0.2, 3.9));
  const vec3 W = vec3(0.5, 0.52, 0.56);
  // misregistration: plate i is shifted by o_i px; first-order: Δv = (∇θ · o) / W
  vec3 mis = (dx * vec3(-0.35, 0.7, 0.95) - dy * vec3(0.8, -0.6, 0.15)) * (p_misreg * pr / (res.y * r * r));
  vec3 v = (crest - th + mis) / W;

  // sheet profile: crisp crest, halftone shading falls off across the sheet, soft pleats inside
  vec3 c = clamp(1.0 - v, 0.0, 1.0);
  vec3 d = smoothstep(-0.03, 0.08, v) * c * sqrt(c);
  vec3 pl = fract(v * 3.0 + 0.15);
  d *= 0.8 + 0.8 * pl * (1.0 - pl);
  d *= 0.72 + 0.36 * vec3(w.z, w.w, 1.0 - w.z);                                   // strengths drift
  d *= vec3(1.0, 0.9, 1.0) * (1.0 - smoothstep(vec3(0.6), vec3(1.95, 2.05, 1.5), r)); // fade away from the focus

  // keep the headline on bare paper (u_contentRect: headline + cards; zeros = unknown)
  vec4 cr = u_contentRect;
  if (cr.z < 1.0) cr = vec4(res.x * 0.22, res.y * 0.45, res.x * 0.56, res.y * 0.47);
  float hh = min(cr.w * 0.42, 190.0 * pr);
  vec2 hq = abs(fc - vec2(cr.x + cr.z * 0.5, cr.y + cr.w - hh * 0.5)) - vec2(cr.z * 0.5, hh * 0.5) + 24.0 * pr;
  float sdH = max(hq.x, hq.y) - 24.0 * pr;
  d = clamp(d * mix(0.05, 1.0, smoothstep(-10.0 * pr, 160.0 * pr, sdH)), 0.0, 1.0);

  // ---- paper: tooth + sparse fibres ----
  vec4 fine = nr(fc * 0.55 / pr);
  float fib = smoothstep(0.84, 0.98, nr(mat2(0.825, 0.565, -0.565, 0.825) * fc * vec2(0.7, 0.12) / pr).r);
  float tooth = fine.a - 0.5;
  vec3 paper = u_dark < 0.5
    ? vec3(0.953, 0.937, 0.902) * (1.0 + 0.03 * tooth) + 0.015 * fib
    : vec3(0.098, 0.110, 0.141) * (1.0 + 0.12 * tooth) + 0.007 * fib;
  vec3 col = paper;

  if (max(d.x, max(d.y, d.z)) > 0.008) {
    float cell = p_loupe * pr;
    vec2 q = fc / cell;
    vec4 blot = nr(q * 1.43 + 11.0);                 // dot-to-dot irregularity
    vec4 mid = nr(fc / (pr * 26.0) + 101.0);         // ink mottle
    float aa = 1.1 / cell;
    vec3 rag = (fine.rgb - 0.5) * 0.13 + (blot.rgb - 0.5) * 0.15;
    vec2 jit = (vec2(blot.a, mid.a) - 0.5) * vec2(0.14, 0.1);          // dots sit slightly off the ideal grid
    vec3 cov = vec3(0.0);
    if (d.x > 0.008) cov.x = screenDot(mat2(0.2588, 0.9659, -0.9659, 0.2588) * q, d.x, rag.x, aa, jit);   // 75°
    if (d.y > 0.008) cov.y = screenDot(mat2(0.9659, 0.2588, -0.2588, 0.9659) * q, d.y, rag.y, aa, jit.yx);   // 15°
    if (d.z > 0.008) cov.z = screenDot(mat2(0.7071, 0.7071, -0.7071, 0.7071) * q, d.z, rag.z, aa, -jit);   // 45°
    // starvation specks where the ink misses the paper's tooth; mottled ink film
    cov *= smoothstep(0.05, 0.16, fine.a + 0.1 * mid.a);
    vec3 film = (0.78 + 0.22 * mid.rgb) * (0.86 + 0.14 * fine.a);

    vec3 A, B, C; inkSet(p_inks, A, B, C);
    if (u_dark < 0.5) {
      // translucent inks multiply on light stock
      vec3 k = cov * film * 0.95;
      col = paper * mix(vec3(1.0), A, k.x) * mix(vec3(1.0), B, k.y) * mix(vec3(1.0), C, k.z);
    } else {
      // dark stock: the ink film covers the paper; overprints still multiply among the inks
      vec3 M = mix(vec3(1.0), A, cov.x) * mix(vec3(1.0), B, cov.y) * mix(vec3(1.0), C, cov.z);
      float U = 1.0 - (1.0 - cov.x) * (1.0 - cov.y) * (1.0 - cov.z);
      float f = dot(cov, film) / max(cov.x + cov.y + cov.z, 1e-3);
      col = mix(paper, M * (0.5 + 0.4 * f), U * 0.94);
    }
  }
  fragColor = vec4(col, 1.0);
}
