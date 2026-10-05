// Cherry blossom (Somei-yoshino), after the owner's reference photos: a mass of tight clusters
// of 4-6 small flowers, clusters overlapping so densely that the branch shows only in short dark
// glimpses. Pale pink to white notched petals, pink centres, yellow-tipped stamens. Three depths:
// soft out-of-focus clusters behind, a shaded middle layer, a bright front layer. The mass sits
// at the top-right, thickest in the corner, thinning along the top edge. Fine petals and pollen
// drift down-left. No background: premultiplied alpha, the card's own glass shows through.
//
// Layout is in CSS px from the TOP-RIGHT corner (c.x leftward, c.y downward), so the mass stays
// put as the message box grows. Every motion term is periodic in T = timePeriod.

const float T = 240.0;
const float TAU = 6.2831853;
const float PI = 3.14159265;

vec4 hash(int x, int row) { return texelFetch(u_noiseTexture, ivec2(x & 255, row & 255), 0); }
vec4 hash2(vec2 cell, int row) { return hash(int(mod(cell.x, 64.0)) + 64 * int(mod(cell.y + 8.0, 4.0)), row); }

float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(u_noiseTexture, (i + f + 0.5) / 256.0).b;
}

vec4 over(vec4 dst, vec4 src) { return src + dst * (1.0 - src.a); }

float E;    // reach of the mass along the top edge
float D;    // reach down the right edge (above the toolbar row; none on the one-row pill)
float AA;   // one device pixel in CSS px
// The padding frame (top 12px, right 16px) is always free for the art. With p_lush the corner
// zone (CX x CY, an organic quarter-ellipse) holds the thick mass; only the far right end of a
// long first line can pass under it.
const float BAND_Y = 12.0;
const float BAND_X = 16.0;
float CX;
float CY;

float cornerZone(vec2 p) {
  if (p_lush < 0.5) return 0.0;
  float wob = 1.0 + 0.14 * sin(atan(p.y, p.x) * 7.0) + 0.06 * sin(atan(p.y, p.x) * 17.0);
  return 1.0 - smoothstep(0.9, 1.0, length(p / vec2(CX, CY)) / wob);
}

// Where the mass may sit (0..1): the corner zone, the top band thinning to the left, the right band.
float allowed(vec2 p) {
  float top = (1.0 - smoothstep(BAND_Y - 3.0, BAND_Y, p.y)) * (1.0 - smoothstep(E * 0.7, E, p.x));
  float right = (1.0 - smoothstep(BAND_X - 3.0, BAND_X, p.x)) * (1.0 - smoothstep(D - 4.0, D, p.y));
  return max(max(top, right), cornerZone(p));
}

// How thick the mass is at p: lush in the corner, thinning along the top edge.
float density(vec2 p) {
  float corner = 1.0 - smoothstep(0.0, max(CX, 40.0) * 1.3, length(p / vec2(1.0, CY / max(CX, 1.0))));
  float along = 1.0 - smoothstep(0.0, E, p.x);
  return clamp(max(corner, pow(along, 1.4) * 0.9), 0.0, 1.0);
}

// One small flower. q: pixel relative to the flower centre. Returns premultiplied colour.
vec4 flower(vec2 q, float r, vec4 h, vec4 g, float shade) {
  float ta = h.r * PI;
  vec2 axis = vec2(cos(ta), sin(ta));
  vec2 q2 = vec2(dot(q, axis), dot(q, vec2(-axis.y, axis.x)) / (0.5 + 0.5 * g.r));   // facing every way
  float d = length(q2);
  if (d > r * 1.1 + AA) return vec4(0.0);
  float sector = TAU / 5.0;
  float ang = atan(q2.y, q2.x) + h.g * TAU;
  float u = (mod(ang, sector) - sector * 0.5) / (sector * 0.5);
  float edge = r * (0.9 + 0.1 * (1.0 - u * u)) - r * 0.16 * exp(-u * u / 0.014);   // broad notched petals
  edge *= mix(1.0, 0.94, smoothstep(0.82, 1.0, abs(u)));
  float a = 1.0 - smoothstep(edge - AA, edge + AA, d);
  if (a <= 0.0) return vec4(0.0);
  float age = g.b;
  // petal: white at the rim, pale pink toward the base, a pinker flush on older flowers
  vec3 col = mix(vec3(1.0, 0.975, 0.98), mix(vec3(0.985, 0.82, 0.87), vec3(0.96, 0.70, 0.79), age), smoothstep(0.95 * r, 0.15 * r, d));
  col *= 1.0 - 0.13 * smoothstep(0.65, 1.0, abs(u));                               // petal overlap seams
  col = mix(col, vec3(0.94, 0.78, 0.84), smoothstep(edge - 1.0, edge, d) * 0.55);  // rim: a pink edge, not grey
  col *= 0.94 + 0.08 * dot(normalize(q2 + 1e-4), vec2(-0.7071, -0.7071)) * smoothstep(0.1 * r, r, d);   // sun from top-right
  // centre: pink star, stamens with yellow tips
  col = mix(col, mix(vec3(0.95, 0.56, 0.67), vec3(0.86, 0.36, 0.50), age), 1.0 - smoothstep(0.13 * r, 0.22 * r, d));
  float rays = smoothstep(0.35, 0.0, abs(fract(ang * 14.0 / TAU) - 0.5));
  col = mix(col, vec3(0.97, 0.88, 0.86), 0.4 * rays * step(0.2 * r, d) * step(d, 0.5 * r));
  float tip = smoothstep(0.3, 0.0, abs(fract(ang * 14.0 / TAU) - 0.5)) * (1.0 - smoothstep(0.0, 0.09 * r + AA, abs(d - 0.52 * r)));
  col = mix(col, vec3(0.96, 0.78, 0.32), tip);
  col *= mix(vec3(0.97, 0.90, 0.93), vec3(1.0), shade) * mix(1.0, shade, 0.6);   // deeper layers: rosier, darker
  return vec4(col * a, a);
}

// A tight cluster of 4-6 flowers at `ctr` (a corymb seen from below: overlapping, all ways).
vec4 cluster(vec2 c, vec2 ctr, float size, float shade, int id) {
  if (length(c - ctr) > size * 2.3 + 2.0) return vec4(0.0);
  vec4 hn = hash(id, 101);
  int n = 4 + int(hn.r * 2.999);
  vec4 col = vec4(0.0);
  for (int i = 0; i < 6; i++) {
    if (i >= n) break;
    vec4 h = hash(id * 7 + i, 113);
    vec4 g = hash(id * 7 + i, 127);
    float ang = float(i) * TAU / float(n) + hn.g * TAU + (h.b - 0.5) * 0.8;
    float dist = i == 0 ? size * 0.15 : size * (0.75 + 0.35 * h.a);
    vec2 fc = ctr + vec2(cos(ang), sin(ang)) * dist;
    float r = size * (0.82 + 0.32 * g.g);
    // flowers further from the viewer (odd ones) sit a touch darker, under their neighbours
    vec4 f = flower(c - fc, r, h, g, shade * (i == 0 ? 1.0 : mix(0.92, 1.0, h.r)));
    col = i == 0 ? f : over(f, col);                                   // the centre flower on top
  }
  return col;
}

// One depth of clusters on a jittered grid. Clusters sit only where the mass may be, filling more
// cells where it is thick. Returns premultiplied colour; `shadow` gathers soft contact shadow.
vec4 layer(vec2 c, float cell, vec2 offset, float sizeBias, float shade, int row, inout float shadow) {
  vec2 p = c + offset;
  vec2 gi = floor(p / cell);
  vec4 col = vec4(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = gi + vec2(float(x), float(y));
      vec4 h = hash2(g, row);
      vec2 ctr = (g + 0.25 + 0.5 * h.rg) * cell - offset;
      float dens = density(ctr) * allowed(ctr);
      if (h.a > dens * 1.15) continue;
      float size = mix(3.0, 4.2, dens) * sizeBias * (0.85 + 0.3 * h.b);
      // keep the cluster inside the frame it belongs to: pull it up toward the top edge
      float inZone = cornerZone(ctr);
      ctr.y = min(ctr.y, mix(BAND_Y - size * 1.6, CY * 0.8 - size * 1.4, inZone));
      shadow = max(shadow, 0.22 * (1.0 - smoothstep(size * 0.6, size * 2.8, length(c - ctr - vec2(1.4, 2.2)))));
      col = over(col, cluster(c, ctr, size, shade, int(g.x * 7.0 + g.y * 131.0) + row * 977));
    }
  return col;
}

// Soft out-of-focus clusters behind the mass (depth, like the blurred blooms in the photos).
vec4 bokeh(vec2 c) {
  vec4 col = vec4(0.0);
  vec2 gi = floor(c / 14.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = gi + vec2(float(x), float(y));
      vec4 h = hash2(g, 211);
      vec2 ctr = (g + 0.2 + 0.6 * h.rg) * 14.0;
      float dens = density(ctr) * allowed(ctr);
      if (h.a > dens * 0.8 || ctr.y > CY) continue;   // only behind the top mass
      float r = 6.0 + 5.0 * h.b;
      float d = length(c - ctr) - r;
      float a = (1.0 - smoothstep(-5.0, 2.0, d)) * 0.42;
      vec3 tint = mix(vec3(0.96, 0.78, 0.85), vec3(0.99, 0.90, 0.93), h.r);
      col = over(col, vec4(tint * a, a));
    }
  return col;
}

// Bark: blackish grey, glimpsed between clusters.
vec4 bark(float dist, float th, float along) {
  float a = 1.0 - smoothstep(th - AA, th + AA, dist);
  vec3 col = vec3(0.20, 0.16, 0.15) * (0.85 + 0.3 * vn(vec2(along * 0.5, 3.0)));
  return vec4(col * a, a);
}

vec4 drift(vec2 px, vec2 c, float t, float cell, float size, int fall, float dens, int row, bool pollen, float frame) {
  float vy = float(fall) * cell * 8.0 / T;
  float vx = float(fall / 2 + 1) * cell * 16.0 / T;
  vec2 p = px + vec2(vx * t, vy * t);
  vec2 id = floor(p / cell);
  vec2 f = p - id * cell;
  int hx = int(mod(id.x, 16.0)) + 16 * int(mod(id.y, 8.0));
  vec4 h = hash(hx, row);
  float near = mix(0.35, 1.0, 1.0 - smoothstep(E * 0.6, E * 2.6, c.x));
  // over the text box: a third as many, half as opaque, so no glyph loses its contrast
  if (h.a > dens * near * mix(0.33, 1.0, frame)) return vec4(0.0);
  float keep = mix(0.5, 1.0, frame);
  vec4 g = hash(hx + 128, row);
  float phase = h.b * TAU;
  vec2 ctr = cell * (0.3 + 0.4 * h.rg) + vec2(sin(t * TAU * 36.0 / T + phase), cos(t * TAU * 22.0 / T + phase)) * cell * 0.1;
  vec2 q = f - ctr;
  if (pollen) {
    float a = (1.0 - smoothstep(size * 0.4, size + AA, length(q))) * 0.75 * keep;
    return vec4(vec3(0.98, 0.90, 0.62) * a, a);
  }
  float spin = phase + t * TAU * (g.r < 0.5 ? -9.0 : 9.0) / T;
  float tumble = 0.25 + 0.75 * abs(cos(t * TAU * (24.0 + floor(g.g * 10.0)) / T + phase));
  q = mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * q;
  q.x /= tumble;
  float s = size * (0.7 + 0.6 * g.b);
  float notch = length(q - vec2(0.0, s * 1.02)) - s * 0.28;
  float d = max(length(vec2(q.x / 0.68, q.y)) - s, -notch) * tumble;
  float a = (1.0 - smoothstep(-AA * 0.6, AA * 0.6, d)) * 0.9 * keep;
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
  D = max(0.0, res.y - 56.0);
  CX = clamp(res.x * 0.1, 46.0, 80.0);
  CY = min(res.x < 500.0 ? 17.0 : 22.0, max(res.y - 28.0, 16.0));   // phones: lines run closer to the corner

  vec4 col = vec4(0.0);
  float frame = max(max(1.0 - smoothstep(BAND_Y - 1.0, BAND_Y, c.y), (1.0 - smoothstep(BAND_X - 1.0, BAND_X, c.x)) * step(c.y, D + 6.0)), cornerZone(c));
  if (c.x < E + 16.0 && c.y < max(max(CY, D), BAND_Y) + 16.0) {
    float shadow = 0.0;
    vec4 back = bokeh(c);
    // the branch, glimpsed only between clusters
    float yb = 3.0 + 0.012 * c.x + 1.2 * sin(c.x * 0.05 + 1.0);
    // the wood only shows inside the mass: short dark glimpses between clusters, never a bare stick
    float glimpse = smoothstep(0.35, 0.7, density(c));
    vec4 wood = bark(abs(c.y - yb), mix(2.6, 0.8, smoothstep(0.0, E, c.x)) * step(c.x, E * 0.95), c.x) * glimpse;
    float xb = 3.0 + 0.6 * sin(c.y * 0.09);
    wood = over(wood, bark(abs(c.x - xb), 2.0 * step(c.y, CY * 0.45), c.y + 50.0) * glimpse);
    vec4 mid = layer(c, 9.0, vec2(4.5, 3.0), 0.92, 0.9, 31, shadow);
    vec4 front = layer(c, 10.0, vec2(0.0), 1.0, 1.0, 47, shadow);
    col = vec4(0.0, 0.0, 0.0, shadow * 0.6);                          // contact shadow on the glass
    col = over(col, back);
    col = over(col, wood);
    col = over(col, mid);
    col = over(col, front);
    col *= frame;                                                     // nothing enters the text box
  }
  col = over(col, drift(px, c, t, 26.0, 1.3, 5, 0.45, 11, false, frame));
  col = over(col, drift(px + 11.0, c, t, 38.0, 2.0, 7, 0.32, 23, false, frame));
  col = over(col, drift(px + 5.0, c, t, 17.0, 0.7, 3, 0.3, 37, true, frame));
  fragColor = col;
}
