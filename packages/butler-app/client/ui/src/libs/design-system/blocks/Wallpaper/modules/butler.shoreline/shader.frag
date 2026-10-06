// Shoreline: a beach seen straight down from high altitude, graded like a frame of film.
// Sand at the top (the headline sits on it), the shoreline crosses below the content, surf lace and
// swash in the open middle, deep water below. The camera sits ZOOM times higher than a close view:
// world units = ZOOM x viewport height, anchored at the mean shoreline. s = distance to shore in
// world units (seaward +). Waves: N fronts per 120 s loop; every time-dependent lookup is periodic.

const float PERIOD = 120.0;             // waves, glints, grain loop in 120 s
const float CLOUD_PERIOD = 240.0;       // cloud shadow drift loop (= timePeriod)
const float ZOOM = 2.6;
const float TAU = 6.2831853;

float vn(vec2 p) { // smooth value noise, period 256
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(u_noiseTexture, (i + f + 0.5) / 256.0).r;
}
vec4 vn4(vec2 p) { // 4 independent smooth value noises in one lookup
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(u_noiseTexture, (i + f + 0.5) / 256.0);
}
float pn(vec2 p, float K) { // value noise periodic in y with integer period K
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, K), y1 = mod(i.y + 1.0, K);
  float a = texture(u_noiseTexture, vec2(i.x + f.x + 0.5, y0 + 0.5) / 256.0).g;
  float b = texture(u_noiseTexture, vec2(i.x + f.x + 0.5, y1 + 0.5) / 256.0).g;
  return mix(a, b, f.y);
}
vec4 hash4(float n) { return texelFetch(u_noiseTexture, ivec2(int(mod(n, 256.0)), 97), 0); }

// nearest cell wall of a jittered cell grid: x = distance to the wall (F2 - F1, cell units),
// y = a random value shared by the whole wall between the two cells (so walls can pop one by one)
vec2 cellEdge(vec2 q) {
  vec2 i = floor(q), f = fract(q);
  ivec2 ib = ivec2(i);
  float d1 = 9.0, d2 = 9.0;
  vec2 o1 = vec2(0.0), o2 = vec2(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 o = texelFetch(u_noiseTexture, (ib + ivec2(x, y)) & 255, 0).rg;
      vec2 r = vec2(float(x), float(y)) + 0.1 + o * 0.8 - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; o2 = o1; d1 = d; o1 = o; } else if (d < d2) { d2 = d; o2 = o; }
    }
  return vec2(sqrt(d2) - sqrt(d1), fract((o1.x + o2.x) * 5.37 + (o1.y + o2.y) * 3.71));
}
// foam at density C: C ~ 1 solid white water, C ~ 0.3 lace, C -> 0 a few loose threads.
// As the foam ages its bubble walls pop one by one, so holes merge into irregular lace.
float foamAt(vec2 q, float scale, float C, float front) {
  vec2 Q = vec2(q.x * 0.75, q.y) * scale;
  vec4 nz = vn4(Q * 0.55 + 11.0);                            // rg: bends each wall, b: strand width, a: popping
  vec2 ce = cellEdge(Q + (nz.rg - 0.5) * 1.0);
  float cc = clamp(C, 0.0, 1.0);
  float wdt = (0.02 + 0.95 * cc * cc) * (0.3 + 1.4 * nz.b);
  float aa = scale * ZOOM / u_resolution.y * 1.9;
  float core = 1.0 - smoothstep(wdt - aa, wdt + aa, ce.x);
  float pop = clamp(0.8 - 1.2 * cc + 0.35 * (nz.a - 0.5), 0.0, 0.97);   // share of walls already gone
  core *= smoothstep(pop - 0.04, pop + 0.04, ce.y);
  float lace = core * mix(0.55, 1.0, cc) * (0.7 + 0.3 * nz.b);
  float f = max(lace * smoothstep(0.05, 0.1, C), (0.1 + 0.2 * nz.r) * cc);
  return f * smoothstep(0.0, 0.02, front - 0.07 * nz.a);                 // ragged leading edge
}

// water optics per palette: absorption (per unit optical depth), in-scattered colour, seabed and sand
void pal(int w, out vec3 absorb, out vec3 scat, out vec3 dry, out vec3 wet) {
  if (w == 1) {        // temperate: greener, more sediment
    absorb = vec3(0.95, 0.42, 0.50); scat = vec3(0.05, 0.19, 0.22);
    dry = vec3(0.80, 0.75, 0.66); wet = vec3(0.55, 0.49, 0.40);
  } else if (w == 2) { // nordic: steel, cold
    absorb = vec3(0.80, 0.52, 0.46); scat = vec3(0.07, 0.14, 0.19);
    dry = vec3(0.76, 0.74, 0.70); wet = vec3(0.47, 0.46, 0.43);
  } else {             // tropical: clear water over pale sand
    absorb = vec3(1.15, 0.26, 0.17); scat = vec3(0.02, 0.19, 0.33);
    dry = vec3(0.86, 0.80, 0.70); wet = vec3(0.68, 0.58, 0.45);
  }
}
vec3 filmic(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

// ---- lighting state, set once in main: theme (day / moonlit night) or the local time of day
float Lnight;          // 0 day grade .. 1 night-for-night grade
vec3 Ltint;            // white balance (linear)
float Lexpo;           // exposure
vec3 LglC, LhaC;       // glint and halation colour (post-exposure)

// cloud shadows: a few large, very soft shapes drifting across sand and water alike on a slow,
// wide loop (240 s, ~1 H across). A low light stretches them along its direction.
float cloudAt(vec2 ps, vec2 gdir, float stretch) {
  vec2 gn = vec2(-gdir.y, gdir.x);
  vec2 cq = (gdir * dot(ps, gdir) / stretch + gn * dot(ps, gn)) * vec2(2.0, 2.6);
  float ang = TAU * u_time / CLOUD_PERIOD;
  cq -= vec2(cos(ang), 0.45 * sin(ang));                        // slow drift, loops in 240 s
  // dayClouds scales the shadows in the day grade only (1: unchanged); the night grade keeps them.
  return mix(p_dayClouds, 1.0, Lnight) * smoothstep(0.5, 0.92, vn(cq + vec2(0.0, u_seed * 50.0) + 40.0));
}

// film look: foam, glints with halation, filmic curve, split tone, vignette, animated grain.
// s: distance to shore (world), gl: glint energy, ha: halation, sheen: moon path on the water
vec3 finish(vec3 col, float fo, float s, vec2 R, float gl, float ha, float sheen) {
  vec3 lw = vec3(0.2126, 0.7152, 0.0722);
  float nt = Lnight;
  col = mix(col, mix(vec3(0.80, 0.85, 0.86), vec3(0.97, 0.965, 0.95), fo), fo * 0.95);
  vec3 L = col * col;                                                  // ~linear light
  // night for night: sand a step darker, a soft moon path, desaturated and cool, underexposed
  if (nt > 0.0) {
    L *= mix(1.0, mix(0.55, 1.0, smoothstep(-0.02, 0.0, s)) * (1.0 + 0.6 * sheen), nt);
    L = mix(vec3(dot(L, lw)), L, mix(1.0, 0.42, nt));
  }
  L *= Ltint * Lexpo;
  L += LglC * gl + LhaC * ha;                                          // glints + halation bloom stay bright
  vec3 y = sqrt(filmic(L));
  float l = dot(y, lw);
  vec3 shT = mix(vec3(-0.035, 0.01, 0.03), vec3(-0.02, 0.01, 0.03), nt);
  vec3 hiT = mix(vec3(0.04, 0.012, -0.035), vec3(0.01, 0.008, 0.0), nt);
  y += shT * (1.0 - l) * (1.0 - l) + hiT * l * l;                      // split tone: teal shadows, warm highlights
  y = mix(vec3(l), y, mix(0.88, 0.82, nt) * min(0.72 + 0.7 * l, 1.0));  // restrained saturation
  y = mix(vec3(0.012, 0.018, 0.024), vec3(0.016, 0.02, 0.028), nt) + y * 0.975;       // soft toe, lifted blacks
  vec2 v = (gl_FragCoord.xy / R - 0.5) * vec2(1.0, 0.9);
  y *= 1.0 - 0.32 * dot(v, v);                                         // vignette
  // grain: new pattern every 1/24 s, strongest in the mid-tones
  float fr = floor(u_time * 24.0);
  ivec2 o = ivec2(int(mod(fr * 71.0, 256.0)), int(mod(fr * 137.0, 256.0)));
  vec4 g = texelFetch(u_noiseTexture, (ivec2(gl_FragCoord.xy) + o) & 255, 0);
  l = dot(y, lw);
  y += (g.r + g.g - 1.0) * mix(0.038, 0.026, nt) * (0.35 + 0.65 * (1.0 - abs(2.0 * l - 1.0)));
  return clamp(y, 0.0, 1.0);
}

void main() {
  vec2 R = u_resolution;
  vec2 ps = gl_FragCoord.xy / R.y;                              // screen, H units
  float asp = R.x / R.y;
  float t = u_time;

  // ---- light: theme, or the sun and moon following the local time (u_dayPhase: 0 midnight, 0.5 noon)
  // theme defaults: the glitter is a tall column right of centre, the light fixed high in the south
  vec2 gdir = vec2(0.0, -1.0);                                  // toward the light, on screen
  vec2 gc = vec2((u_dark > 0.5 ? 0.64 : 0.66) * asp, 0.2);     // glint centre
  float gLen = 6.0, gWid = 0.15, glI = 1.0, stretch = 1.0;
  float relief = 1.0, lo = 0.0, pathK = 0.0, shW = 0.05;        // ripple shading, low-light glitter, path body, sheen width
  if (p_realtime > 0.5) {
    float ph = u_dayPhase;
    float el = sin(TAU * (ph - 0.25));                          // sun elevation (-1 midnight .. 1 noon)
    float dw = smoothstep(-0.14, 0.06, el);                     // day weight through twilight
    float warm = dw * (1.0 - smoothstep(0.05, 0.42, el));       // dawn / golden hour
    float bh = exp(-(el + 0.05) * (el + 0.05) / 0.005);         // blue hour
    Lnight = 1.0 - dw;
    Ltint = mix(vec3(0.64, 0.83, 1.2), mix(vec3(0.98, 1.0, 1.04), vec3(1.16, 0.95, 0.72), warm), dw)
          * mix(vec3(1.0), vec3(1.04, 0.9, 1.1), 0.6 * bh);
    Lexpo = exp(mix(log(0.16), log(mix(0.55, 0.95, smoothstep(0.0, 0.5, el))), dw));
    // the sun by day, the moon (opposite the sun) by night; the glint fades out at each horizon crossing
    float h = el >= 0.0 ? (ph - 0.5) / 0.25 : (fract(ph + 0.5) - 0.5) / 0.25;   // hour angle: -1 east .. 1 west
    float a = clamp(h, -1.2, 1.2) * 1.5707963;
    float elev = abs(el);
    gdir = vec2(-sin(a), -cos(a));                              // east = right, south = down (the sea), west = left
    gc = vec2(asp * (0.5 - 0.42 * sin(a)), 0.2 - 0.06 * cos(a) * (1.0 - elev));
    gLen = 0.12 + 0.42 * (1.0 - elev);                          // low light draws a long glitter path
    gWid = 0.09 + 0.06 * elev;
    glI = smoothstep(0.0, 0.1, elev);
    stretch = mix(1.8, 1.0, elev);                              // long shadows under a low light
    relief = dot(vec2(0.34, 0.94), gdir) * mix(2.2, 1.0, elev); // ripple shading follows the light
    lo = 1.0 - elev;                                            // a low light scatters more glitter
    pathK = 0.015 + 0.03 * lo;
    shW = 0.25;
    vec3 sunG = mix(vec3(1.0, 0.94, 0.84), vec3(1.05, 0.68, 0.4), warm) * 1.05;
    LglC = mix(vec3(0.45, 0.58, 0.88), sunG, dw) * glI;
    LhaC = mix(vec3(0.12, 0.16, 0.26), vec3(1.0, 0.42 + 0.1 * (1.0 - warm), 0.2) * 0.95, dw) * glI;
  } else {
    Lnight = u_dark > 0.5 ? 1.0 : 0.0;
    Ltint = u_dark > 0.5 ? vec3(0.64, 0.83, 1.2) : vec3(1.0);
    Lexpo = u_dark > 0.5 ? 0.16 : 0.95;
    LglC = u_dark > 0.5 ? vec3(0.45, 0.58, 0.88) : vec3(1.0, 0.94, 0.84) * 0.95;
    LhaC = u_dark > 0.5 ? vec3(0.12, 0.16, 0.26) : vec3(1.0, 0.42, 0.2) * 0.95;
    if (u_dark > 0.5) gc.x = 0.64 * asp;
  }


  float sx = u_seed * 37.0;
  float px = ZOOM / R.y;                                        // one pixel in world units

  // ---- shoreline: anchored under the content rect, gently curving, near-horizontal
  float anchor = u_contentRect.w > 1.0 ? u_contentRect.y / R.y : 0.55;
  float base = clamp(anchor - 0.07 + (p_shorePosition - 0.5) * 0.36, 0.22, 0.8);
  vec2 p = vec2(ps.x - 0.5 * R.x / R.y, ps.y - base) * ZOOM;     // world, mean shoreline at y = 0
  float kx = 2.1, ph = 0.8 + u_seed * 3.0;
  vec4 xn = vn4(vec2(p.x * 1.6 + sx, 3.5));                    // r: shore wobble, g: sand bar
  float ys = 0.045 * sin(p.x * kx + ph) + 0.03 * (xn.r - 0.5);
  float slope = 0.045 * kx * cos(p.x * kx + ph);
  float s = (ys - p.y) / sqrt(1.0 + slope * slope);
  float x = p.x;

  vec3 absorb, scat, dry, wet;
  pal(p_water, absorb, scat, dry, wet);
  vec3 sky = vec3(0.70, 0.80, 0.88);

  // ---- sand: mottling, wind ripple marks, fine speckle
  vec4 sn = vn4(p * vec2(9.0, 12.0) + sx);
  float ripple = sin((p.y * 0.94 + p.x * 0.34) * 330.0 + 7.0 * sn.b + 3.0 * sn.a);
  vec3 sand = dry * (1.0 + 0.018 * relief * ripple * sn.a);
  if (s < -0.125) {                                              // dry beach: cheap path
    fragColor = vec4(finish(sand * (1.0 - 0.24 * cloudAt(ps, gdir, stretch)), 0.0, s, R, 0.0, 0.0, 0.0), 1.0);
    return;
  }

  // ---- waves: N fronts per loop; each front keeps its own shape as it travels
  float N = clamp(floor(18.0 * p_waveFrequency + 0.5), 8.0, 30.0);
  float T = PERIOD / N;
  float lam = 0.13;
  float tw = t / T;
  float eta = s / lam + tw;
  float Sb = 0.17 + 0.05 * xn.g;                                 // breaker line (sand bar)
  float w = 0.30 * (pn(vec2(x * 2.4 + sx, eta), N) - 0.5)
          + 0.10 * (vn4(vec2(x * 9.0 + sx, 60.0)).b - 0.5);     // fine front detail (static)
  w *= lam;
  float u = s + w;
  float phi = u / lam + tw;
  float fr = fract(phi);
  float j = floor(phi);
  vec4 bn = vn4(vec2(x * 3.0 + sx, s * 4.0 + 20.0));           // r: depth, g: colour drift, ba: bed warp
  float d = max(s, 0.0) * (0.85 + 0.5 * bn.r);

  // ---- water: seabed seen through the column + in-scattering + sky reflection + glints
  float scroll = t / PERIOD * 256.0;
  vec4 r1 = vn4(vec2(x * 130.0 + scroll * 0.5, s * 150.0));    // surface ripples (slope proxy)
  float sbed = s + (r1.r - 0.5) * 0.005;                       // soft refraction of the bed
  vec3 bed = mix(wet, dry, 0.7) * (0.92 + 0.08 * (bn.g - 0.5));
  vec3 Tr = exp(-absorb * (d * 13.0 + 0.25 * smoothstep(0.0, 0.02, d)));   // a long, gently shelving gradient
  vec3 wc = bed * Tr + scat * (1.0 - Tr) * (0.94 + 0.12 * bn.g);
  // swell: soft lighter crest band, stronger as it nears the bar
  float outside = smoothstep(Sb - 0.03, Sb + 0.05, u);
  float steep = mix(0.35, 1.0, smoothstep(Sb + 0.3, Sb, u));
  float crest = 0.5 + 0.5 * cos(6.2831853 * (fr - 0.12)) + 0.5 * exp(-(1.0 - fr) * 14.0);
  wc *= 1.0 + 0.08 * (crest - 0.6) * outside * steep;
  // sky reflection varies with the ripple slopes; sun glints twinkle on the open water
  float deepish = smoothstep(0.01, 0.12, d);
  wc = mix(wc, sky, (0.03 + 0.05 * r1.b * r1.b) * deepish);
  // glitter path around the light's reflection, stretched toward it when the light is low
  vec2 dq = ps - gc;
  float al = dot(dq, gdir) / gLen, ac = dot(dq, vec2(-gdir.y, gdir.x)) / gWid;
  float r2 = al * al + ac * ac;
  float q1 = max(1.0 - r2 * 0.25, 0.0), q2 = max(1.0 - shW * r2 * 0.25, 0.0);
  float sun = q1 * q1 * q1 * q1 * smoothstep(0.05, 0.35, d);                  // ~exp(-r2)
  float sheen = q2 * q2 * q2 * q2 * smoothstep(-0.02, 0.2, s) * glI;
  float glE = 0.0, haE = 0.0;
  if (sun > 0.01) {
    vec2 fc = gl_FragCoord.xy * vec2(0.5, 0.85);
    float g = vn(fc + vec2(2.0 * scroll, scroll)) * (0.25 + 0.75 * r1.g);
    g *= 0.75 + 0.5 * r1.a;                                       // sparkles ride the ripple facets
    glE = sun * sun * smoothstep(0.78 - 0.18 * lo, 0.92 - 0.1 * lo, g) * 2.6;
    haE = sun * sun * (smoothstep(0.5, 0.8, g) * 0.14 + 0.025);   // halation: warm bloom around the glints
    glE += sun * sun * pathK;                                     // faint body of the reflection path (real time)
  }

  // ---- foam in the surf zone
  float amt = p_foamAmount;
  float foam = 0.0, turb = 0.0;
  if (u < Sb + 0.03 && s > -0.01) {
    float a = fr;
    vec4 hh = hash4(mod(j, N) * 7.0 + 3.0);
    float size = 0.45 + 0.55 * hh.a;                            // sets: some waves are small
    float Sj = Sb * (0.72 + 0.4 * size);                        // big waves break further out
    float brk = smoothstep(Sj + 0.01, Sj - 0.025, u);
    vec4 hz = vn4(vec2(x * 6.0 + hh.b * 20.0, u * 16.0 + a * 1.5 + hh.b * 30.0));
    float C = (exp(-a * 2.6) + 0.22 * exp(-a * 1.0)) * size * (0.55 + 0.6 * hz.g) * (0.6 + 0.8 * amt) * brk;
    float pch = smoothstep(0.2, 0.75, hz.r);                   // patchy, streaky coverage along the front
    C *= mix(0.85 + 0.3 * pch, 0.35 + 0.95 * pch, smoothstep(0.05, 0.4, a));
    turb = clamp(C * 1.3 + 0.25 * brk * size * (0.5 + 0.5 * hz.b), 0.0, 1.0);  // wet trail: sediment-milky water
    if (C > 0.05) {
      vec2 q = vec2(x, u + 0.2 * lam * a) + hh.b * vec2(17.3, 5.1);   // foam drifts shoreward after the bore
      foam = foamAt(q, 80.0, C, a);
    }
  }
  vec3 milky = mix(scat, vec3(0.62, 0.76, 0.72), 0.55);
  wc = mix(wc, milky, 0.42 * turb);

  vec3 col = wc;
  float fo = foam;
  if (s < 0.004) {
    // wet sand below the last high-water line, with a sky sheen
    float hw = -0.1 - 0.015 * vn(vec2(x * 6.0 + sx, 90.0));
    float wetAmt = smoothstep(hw, hw + 0.06, s) * (0.8 + 0.2 * smoothstep(hw + 0.01, -0.01, s));   // soft, no hard line
    sand = mix(sand, wet, wetAmt * 0.75);
    // swash: the latest bore runs up the beach and slides back
    float phi0 = w / lam + tw;
    float tau = fract(phi0);
    vec4 hh = hash4(mod(floor(phi0), N) * 7.0 + 3.0);
    float size = 0.45 + 0.55 * hh.a;
    float Rr = 0.07 * (0.5 + 0.5 * size) * (0.6 + 0.7 * vn4(vec2(x * 3.0 + hh.g * 50.0 + sx, 80.0)).r)
                     * (0.85 + 0.3 * vn4(vec2(x * 12.0 + hh.g * 20.0, 81.0)).g);
    float z = clamp(tau / 0.92, 0.0, 1.0);
    float zz = pow(z, 0.7);
    float e = -Rr * 4.0 * zz * (1.0 - zz);        // run-up edge (negative: up the beach)
    float up = 1.0 - smoothstep(0.4, 0.6, zz);
    float cov = smoothstep(e - px, e + px, s);
    float h = clamp((s - e) / max(-e, 1e-4), 0.0, 1.0);
    // glossy wet sand: sky reflected in the film of water left in the sand
    float gloss = wetAmt * (0.08 + 0.1 * sn.g);
    // fading wet trail where the backwash has just drained
    float trail = step(-Rr, s) * (1.0 - cov) * (1.0 - up) * (1.0 - z);
    gloss += 0.22 * trail;
    vec3 sc = mix(sand * (1.0 - 0.12 * trail), sky, gloss);
    // swash film: sand through a thin sheet of water
    vec3 film = mix(mix(wet * 0.92, sky, 0.22), wc, 0.1 + 0.85 * h * sqrt(h));
    sc = mix(sc, film, cov);
    // foam carried by the swash: dense lace at the leading edge, dissolving behind it
    float sf = 0.0;
    float Cs = (0.3 * exp(-tau * 2.5) + exp(-(s - e) / 0.006) * mix(0.45, 1.0, up)) * (0.5 + 0.8 * amt);
    if (cov > 0.0 && Cs > 0.05) {
      vec2 q = vec2(x, s - 0.6 * e) + hh.g * vec2(13.0, 3.0);
      sf = foamAt(q, 90.0, Cs, 1.0) * cov * smoothstep(0.0, 0.04, z);
    }
    float fs = max(fo * step(0.0, s), sf);
    float k0 = smoothstep(0.0, 0.004, s);
    col = mix(sc, wc, k0);
    fo = mix(fs, fo, k0);
  }
  float wet0 = smoothstep(0.0, 0.01, s);
  float cloud = cloudAt(ps, gdir, stretch);
  col *= 1.0 - 0.24 * cloud;
  float cg = wet0 * (1.0 - 0.85 * cloud);                       // a passing cloud dims the glitter
  fragColor = vec4(finish(col, fo, s, R, glE * cg, haE * cg, sheen), 1.0);
}
