// Dusk Horizon: a planet's limb at dusk seen from very high altitude, graded like a scanned film frame.
// The horizon is a huge circle whose crest sits just under the greeting + cards, so every sky band
// (orange-red limb glow -> amber -> lavender -> cerulean -> navy) is concentric with the curve.
// Light theme = the same place at dawn: pale aqua/cerulean sky, rose-apricot and pale gold at the
// limb, indigo ground with fewer lights, cooler balance.
// A cinematic grade follows: halation around the glow band, a filmic curve with warm lifted blacks,
// teal shadows / amber highlights, restrained saturation (the orange keeps its punch), heavy
// per-frame grain and a few slow-fading dust specks and hairline scratches.
// Below the limb: city lights (sodium orange, a few cool whites) in towns and road strands, under
// drifting cloud wrinkles, all sliding slowly toward the viewer as if flying toward the horizon.
// Motion: grain changes every frame, the glow band breathes and shimmers along the limb, and its
// brightest stretch drifts very slowly sideways. Every cycle closes over PERIOD (= timePeriod).

const float PERIOD = 7680.0;
const float TAU = 6.2831853;

vec3 lin(vec3 c) { return c * c; }
float cyc(float k, float ph) { return sin(TAU * (fract(k * u_time / PERIOD) + ph)); }   // k whole cycles
vec4 vn4(vec2 q) {                                     // four C1 value-noise fields, one bilinear fetch
  vec2 i = floor(q), f = q - i;
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(u_noiseTexture, (i + f + 0.5) * (1.0 / 256.0), 0.0);
}

// one candidate city light per world cell c (hash offset by the seed), re-projected
// to the screen so it stays a round point whatever the perspective
const vec2 CS = vec2(0.025, 160.0 / 3584.0);            // cell size in world units; 3584 = 14 x 256 per repeat
vec3 cityLight(ivec2 c, ivec2 so, float prob, float fly, float xo, float px, float g, float shimA) {
  vec4 h = texelFetch(u_noiseTexture, (c + so) & 255, 0);
  if (h.x >= prob) return vec3(0.0);
  vec2 lw = (vec2(c) + 0.2 + 0.6 * h.yz) * CS;          // light in world
  float zl = lw.y - fly;
  vec2 dp = vec2((lw.x - xo) / (zl * 1.3) - px, 0.32 / zl - 0.018 - g) * u_resolution.y;   // offset in pixels
  float r = (0.5 + 0.6 * h.w) * mix(0.65, 1.0, smoothstep(0.06, 0.35, g));
  float e = dot(dp, dp) / (r * r);
  float I = (0.25 + 0.75 * h.w * h.w) * (1.0 + shimA * cyc(2400.0 + floor(h.y * 700.0), h.z));
  vec3 lc = fract(h.w * 7.31) < 0.18 ? vec3(0.78, 0.86, 1.0) : vec3(1.0, 0.5, 0.17);
  return lc * I * (exp(-e) + 0.07 * exp(-0.12 * e));
}

// soft stop blend: halfway between linear and smoothstep, so stops leave no flat bands
float sb(float a, float b, float x) { float u = clamp((x - a) / (b - a), 0.0, 1.0); return u * (0.5 + u * (1.5 - u)); }

void main() {
  vec2 R = u_resolution, fc = gl_FragCoord.xy;
  float L = u_dark > 0.5 ? 0.0 : 1.0;                  // dark theme = dusk; light theme = the same place at dawn
  vec4 cr = u_contentRect;

  // crest of the limb just under the content, so the greeting sits in the sky and the band below the cards
  float hy = 0.45 * R.y;
  if (cr.z > 0.0) hy = clamp(cr.y - 0.035 * R.y, 0.38 * R.y, 0.5 * R.y);
  vec2 p = (fc - vec2(0.5 * R.x, hy)) / R.y;

  // planet: circle of radius Rp below the crest; d = altitude above the limb (screen heights)
  float Rp = 1.0 / mix(0.03, 0.26, clamp(p_curvature, 0.0, 1.0));
  float d = length(p + vec2(0.0, Rp)) - Rp;
  float skyH = max(1.0 - hy / R.y, 0.3);
  float s = max(d, 0.0) * 0.55 / skyH;                 // sky altitude, ~0.55 at the top of the frame
  s = mix(s, min(s, 0.27) + max(s - 0.27, 0.0) * 0.82, L);   // light: a touch more of the cerulean band

  // ---------------- sky: stops sampled along the curve (sRGB; dark = dusk | light = dawn), blended softly ----------------
  vec3 col = vec3(0.0);
  if (d < -0.0045) {
  } else if (s < 0.077) {
    col = mix(vec3(0.80, 0.25, 0.13), vec3(0.97, 0.54, 0.44), L);
    col = mix(col, mix(vec3(0.85, 0.31, 0.15), vec3(0.99, 0.64, 0.46), L), sb(0.0, 0.013, s));
    col = mix(col, mix(vec3(0.87, 0.48, 0.20), vec3(1.0, 0.77, 0.54), L), sb(0.013, 0.034, s));
    col = mix(col, mix(vec3(0.87, 0.62, 0.38), vec3(0.98, 0.85, 0.70), L), sb(0.034, 0.055, s));
    col = mix(col, mix(vec3(0.84, 0.68, 0.55), vec3(0.95, 0.86, 0.80), L), sb(0.055, 0.077, s));
  } else if (s < 0.27) {
    col = mix(vec3(0.84, 0.68, 0.55), vec3(0.95, 0.86, 0.80), L);
    col = mix(col, mix(vec3(0.72, 0.60, 0.56), vec3(0.88, 0.85, 0.86), L), sb(0.077, 0.11, s));
    col = mix(col, mix(vec3(0.63, 0.56, 0.61), vec3(0.80, 0.84, 0.89), L), sb(0.11, 0.13, s));
    col = mix(col, mix(vec3(0.57, 0.57, 0.68), vec3(0.71, 0.84, 0.91), L), sb(0.13, 0.16, s));
    col = mix(col, mix(vec3(0.46, 0.56, 0.72), vec3(0.61, 0.81, 0.91), L), sb(0.16, 0.21, s));
    col = mix(col, mix(vec3(0.40, 0.57, 0.74), vec3(0.52, 0.76, 0.91), L), sb(0.21, 0.27, s));
  } else {
    col = mix(vec3(0.40, 0.57, 0.74), vec3(0.52, 0.76, 0.91), L);
    col = mix(col, mix(vec3(0.28, 0.49, 0.70), vec3(0.44, 0.68, 0.88), L), sb(0.27, 0.345, s));
    col = mix(col, mix(vec3(0.17, 0.36, 0.54), vec3(0.38, 0.61, 0.85), L), sb(0.345, 0.4, s));
    col = mix(col, mix(vec3(0.11, 0.23, 0.37), vec3(0.33, 0.55, 0.81), L), sb(0.4, 0.45, s));
    col = mix(col, mix(vec3(0.075, 0.135, 0.22), vec3(0.28, 0.48, 0.75), L), sb(0.45, 0.53, s));
  }
  vec3 sky = lin(col);

  // ---------------- ground: the night side from cruising altitude, flying toward the horizon ----------------
  // Perspective ground: z = distance along the ground, X = lateral. Flight slides the ground (and, a
  // little faster, the closer cloud layer) toward the viewer; every layer repeats every 160 world
  // units and the offsets close whole repeats over PERIOD, so the loop is seamless.
  float g = max(-d, 0.0);
  vec3 ground = mix(lin(mix(vec3(0.072, 0.062, 0.055), vec3(0.07, 0.078, 0.12), L)),
                    lin(mix(vec3(0.20, 0.12, 0.11), vec3(0.15, 0.155, 0.235), L)), exp(-g / 0.085));   // dusk brown | dawn indigo
  float gn = 0.0;
  if (d < 0.0) {
    float z = 0.32 / (g + 0.018);
    float xo = 61.0 * fract(u_seed * 7.13);               // per-seed placement, stable
    float X = p.x * z * 1.3 + xo;
    float fly = fract(u_time / PERIOD * 2.0) * 160.0;
    float Wg = z + fly;                                   // ground: 2 repeats per period
    float Wc = z + fract(u_time / PERIOD * 3.0) * 160.0;  // clouds: 3 (closer, so a touch faster)
    float far = smoothstep(0.004, 0.05, g);

    // clouds: billowed wrinkles that drift over the lights
    vec2 cu = vec2(X + 25.0, Wc) * 1.6;
    gn = 0.65 * vn4(cu).x + 0.35 * vn4(cu * 2.0 + 17.0).y;
    float cloud = smoothstep(0.5, 0.8, gn) * far;
    ground *= 1.0 + (gn - 0.5) * mix(0.4, 0.26, L) * far;
    // dawn: the cloud wrinkles pick up a faint cool rim of skylight
    float rim = smoothstep(0.46, 0.6, gn) * (1.0 - smoothstep(0.6, 0.8, gn));
    ground += L * lin(vec3(0.46, 0.56, 0.74)) * rim * 0.045 * (0.35 + 0.65 * exp(-g / 0.12)) * far;

    // towns (irregular clusters) and the roads strung between them, with dark countryside around
    vec4 tn = vn4(vec2(X + 60.0, Wg) * 4.8);
    float town = smoothstep(0.62, 0.9, tn.x) * (0.55 + 0.45 * tn.y);
    float road = smoothstep(0.02, 0.0, abs(tn.w - 0.5)) * smoothstep(0.4, 0.62, tn.z);
    float prob = (0.012 + 0.75 * town + 0.5 * road) * mix(1.0, 0.4, L);   // dawn: fewer lights still on

    // individual lights: one candidate per world cell; the pixel's cell and the nearer one in depth
    // are tested, each light re-projected to the screen so it stays a round point
    vec2 wc = vec2(X, Wg) / CS, ci = floor(wc);
    float fy = wc.y - ci.y;
    int o = fy < 0.5 ? -1 : 1;
    ivec2 so = ivec2(u_seed * 911.0, u_seed * 353.0);
    float near = smoothstep(0.035, 0.09, g);              // far lights melt into a glow
    float shimA = 0.06 + 0.2 * exp(-g / 0.08);            // longer air path, more shimmer
    vec3 lights = vec3(0.0);
    if (near > 0.0) {
      lights = cityLight(ivec2(ci), so, prob, fly, xo, p.x, g, shimA);
      if (min(fy, 1.0 - fy) * CS.y * R.y * 0.32 / (z * z) < 3.5)   // the neighbour in depth, only within a bloom of the edge
        lights += cityLight(ivec2(ci) + ivec2(0, o), so, prob, fly, xo, p.x, g, shimA);
    }
    vec3 sodium = vec3(1.0, 0.5, 0.17);
    ground += lights * mix(1.6, 0.75, L) * near * (1.0 - 0.85 * cloud);
    ground += sodium * (0.7 * town + 0.25 * road) * mix(0.012, 0.004, L) * (1.0 - 0.6 * near) * far * (1.0 - 0.5 * cloud);
    ground += sodium * town * 0.004 * cloud * (1.0 - L);              // cloud tops lit from the towns beneath
  }

  col = mix(ground, sky, smoothstep(-0.0045, 0.0045, d));   // slightly defocused limb

  // ---------------- the glow band: breathes, shimmers along the limb, brightest stretch drifts ----------------
  float ad = abs(d);
  if (ad < 0.25) {                                      // beyond this the band and its halo are nil
    float loop = u_time / PERIOD;
    float sunX = 0.14 * cyc(3.0, 0.0) - 0.04;
    float az = exp(-(p.x - sunX) * (p.x - sunX) * 1.1);
    float breath = 1.0 + 0.07 * cyc(800.0, 0.0) + 0.035 * cyc(1213.0, 0.3);
    float G = (0.4 + clamp(p_glow, 0.0, 1.0)) * breath * (0.8 + 0.25 * az);
    float up = max(d, 0.0), dn = max(-d, 0.0);
    float sh = 0.5, sh2 = 0.5;                            // shimmer, evolving in place (only near the core)
    if (up < 0.1 && dn < 0.03) {
      sh = vn4(vec2(p.x * 7.0 + 30.0, 256.0 * 6.0 * loop)).x;
      sh2 = vn4(vec2(p.x * 19.0 + 90.0, 256.0 * 11.0 * loop + 50.0)).y;
    }
    float wz = exp(-up / 0.05 - dn / 0.009);            // the warm zone the glow controls
    float core = exp(-up / 0.018 - dn / 0.004);
    col *= mix(1.0, G * (1.0 + core * (0.2 * sh + 0.1 * sh2 - 0.15)), wz);
    vec3 cCore = lin(mix(vec3(0.95, 0.40, 0.16), vec3(1.0, 0.76, 0.52), L));   // dusk ember | dawn gold
    col += G * cCore * exp(-up / 0.006 - dn / 0.005) * 0.22 * (0.85 + 0.3 * sh);   // hot filament
    col += G * cCore * 0.16 * gn * gn * exp(-g / 0.02);                    // embers under the limb
    // film halation: the band bleeds red-orange into its surroundings
    col += G * lin(mix(vec3(1.0, 0.36, 0.16), vec3(1.0, 0.64, 0.52), L)) * mix(1.0, 0.7, L) * (0.11 * exp(-ad / 0.022) + 0.035 * exp(-ad / 0.09) * smoothstep(0.25, 0.1, ad));
  }

  // ---------------- grade ----------------
  vec3 c = sqrt(max(col, 0.0));
  vec3 t = max(c - 0.78, 0.0);                          // gentle highlight roll-off
  c = min(c, vec3(0.78)) + t / (1.0 + t / 0.2);
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.16);            // soft S: filmic toe + shoulder
  float Y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float warm = clamp(p_warmth, 0.0, 1.0) - 0.5;
  // split toning: teal in the shadow-mids, amber in the highlights
  float wS = smoothstep(0.55, 0.12, Y) * smoothstep(0.0, 0.12, Y);
  float wH = smoothstep(0.45, 0.95, Y);
  c += vec3(-0.030, 0.006, 0.030) * wS * (1.0 - warm) + vec3(0.034, 0.012, -0.030) * wH * (1.0 + warm) * mix(1.0, 0.45, L);
  c *= 1.0 + vec3(-0.035, 0.0, 0.035) * L;              // dawn: cooler white balance
  c *= 1.0 + vec3(0.07, 0.01, -0.07) * warm;
  // restrained saturation, except the orange band
  float om = clamp((c.r - c.b) * 2.2, 0.0, 1.0) * clamp((c.r - c.g) * 3.5, 0.0, 1.0);
  Y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(Y), c, mix(0.88, 1.08, om));
  // warm, lifted film base
  vec3 lift = mix(vec3(0.050, 0.040, 0.034), vec3(0.040, 0.046, 0.060), L);
  c = lift + (1.0 - lift) * c;
  // vignette: the frame falls off toward the corners
  vec2 vq = (fc / R - 0.5) * vec2(R.x / R.y, 1.0);
  c *= mix(mix(0.72, 0.8, L), 1.0, smoothstep(1.05, 0.3, length(vq)));

  // greeting stays readable: local care behind the upper part of the content rect only.
  // dark theme (light text): settle the sky a little; light theme (dark text): a soft luminous
  // cerulean bloom behind the greeting, fading out well before the band.
  float head = 0.0;
  if (cr.z > 0.0) {
    vec2 lo = vec2(cr.x, cr.y + cr.w * 0.55), hi = cr.xy + cr.zw;
    vec2 dd = abs(fc - 0.5 * (lo + hi)) - 0.5 * (hi - lo);
    float sd = length(max(dd, 0.0)) + min(max(dd.x, dd.y), 0.0);
    head = 1.0 - smoothstep(-0.04 * R.y, mix(0.14, 0.2, L) * R.y, sd);
    c = L < 0.5 ? c * (1.0 - 0.16 * head) : mix(c, vec3(0.72, 0.85, 0.96), 0.35 * head);
  }

  // ---------------- dust specks & hairline scratches (static frame, fading slowly) ----------------
  // sky only: on the ground, points of light are the city lights
  float dust = 0.0;
  if (d > 0.0) {
    vec2 cell = floor(fc / 36.0);
    vec4 h = texelFetch(u_noiseTexture, ivec2(cell + vec2(13.0, 101.0)) & 255, 0);
    if (h.x > 0.972) {
      vec2 pos = cell * 36.0 + 5.0 + h.yz * 26.0;
      float r = 0.45 + 1.1 * h.w * h.w;
      float fade = smoothstep(0.1, 0.9, 0.5 + 0.5 * cyc(40.0 + floor(h.y * 60.0), h.w));
      dust = smoothstep(r + 0.9, r - 0.3, length(fc - pos)) * fade * (0.35 + 0.4 * h.z);
    } else if (h.x < 0.0035) {
      float an = h.y * 3.1416;
      vec2 dir = vec2(cos(an), sin(an)), q = fc - (cell * 36.0 + 18.0);
      float along = dot(q, dir), across = dot(q, vec2(-dir.y, dir.x)) - 0.004 * along * along;
      float hl = 8.0 + 9.0 * h.z;
      dust = smoothstep(0.85, 0.15, abs(across)) * smoothstep(hl, hl - 5.0, abs(along)) * 0.22;
    }
  }
  c = mix(c, vec3(0.86, 0.82, 0.76), dust * (1.0 - 0.7 * head));

  // ---------------- grain: heavy, fine, new every frame ----------------
  uint fr = uint(u_time * 24.0);
  vec3 r3 = texelFetch(u_noiseTexture, (ivec2(fc) + ivec2(fr * 73u, fr * 151u)) & 255, 0).xyz;
  Y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float amp = 0.12 * clamp(p_grain, 0.0, 1.0) * (0.42 + 0.58 * 4.0 * Y * (1.0 - Y));
  float gm = r3.x + r3.y - 1.0;                          // triangular
  c += amp * (gm + vec3(0.12, 0.0, -0.12) * (r3.z - 0.5));
  fragColor = vec4(c, 1.0);
}
