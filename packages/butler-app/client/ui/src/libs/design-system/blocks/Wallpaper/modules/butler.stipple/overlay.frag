// Stipple - per-frame pass over the cached base (u_base: r tone, g vignette, b headline mask, a ink laydown).
// Per device pixel: one base fetch, one breathing-field fetch, one noise texel -> a two-tone 1 px stipple.
//  - light theme: dark ink marks shadows; dark theme / "bone": light ink marks highlights on deep paper, so the
//    picture reads the same way round; invert swaps ink and paper colours (a negative); softness pulls the ink
//    toward grey and toward the paper
//  - grain: exactly 1 device px white noise (per-256-px-tile offsets, no visible repeat), thresholded with a
//    slight soft edge; each pixel's threshold is a slowly rotating mix of two independent noise values, so dots
//    fade on/off smoothly (no per-frame re-roll, no translation)
//  - breathing: a large slow field thickens / thins the midtones; light sweep: a soft slanted band crosses the
//    frame twice per loop, lifting the lighter tones
//  - vignette thins the print to bare paper (the paper after invert); headline clears toward the title's tone
// Loop: T = 120 s (grain 7 turns, breath 3, sweep 2 passes) -> seamless.
const float T = 120.0;
const float TAU = 6.2831853;

vec4 nz(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return texture(u_noiseTexture, (i + f + .5) / 256.); }

void pair(int k, bool dark, out vec3 ink, out vec3 paper) {
  if (k == 3) { ink = vec3(.925, .898, .835) * (dark ? .9 : 1.); paper = vec3(.075, .086, .196); return; }   // bone on indigo
  if (!dark) {
    if (k == 1) { ink = vec3(.890, .243, .153); paper = vec3(.957, .922, .851); }             // vermilion on cream
    else if (k == 2) { ink = vec3(.102, .314, .212); paper = vec3(.929, .906, .851); }        // deep green on bone
    else { ink = vec3(.169, .169, .961); paper = vec3(.965, .961, .945); }                    // ultramarine on white
  } else {
    if (k == 1) { ink = vec3(.93, .56, .46); paper = vec3(.149, .051, .035); }
    else if (k == 2) { ink = vec3(.58, .77, .65); paper = vec3(.035, .110, .078); }
    else { ink = vec3(.56, .56, .95); paper = vec3(.047, .047, .205); }
  }
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  ivec2 ip = ivec2(fc);
  vec4 base = texelFetch(u_base, ip, 0);
  bool dark = u_dark > .5;
  vec3 ink, paper; pair(p_ink, dark, ink, paper);
  bool lightInk = dark || p_ink == 3;                   // which tone the coverage marks (picture reads positive)
  float y = dot(ink, vec3(.2126, .7152, .0722));
  ink = mix(mix(ink, vec3(y), .45 * p_tone), paper, .55 * p_tone);   // softness
  bool inv = p_invert > .5;
  if (inv) { vec3 k = ink; ink = paper; paper = k; }    // invert: ink areas take the paper colour and vice versa
  bool inkLight = lightInk != inv;                      // is the colour laid by coverage the light one?
  float pr = max(u_pixelRatio, 1e-3);
  vec2 uv = fc / u_resolution;
  float t = u_time, ang = TAU * t / T;

  // light sweep on the tone
  float tn = base.r;
  float sx = uv.x + (uv.y - .5) * .5 * u_resolution.y / u_resolution.x;
  float band = exp(-pow((sx - mix(-.55, 1.55, fract(t / (T / 2.)))) / .17, 2.));
  tn = clamp(tn + band * .17 * p_sweep * smoothstep(.05, .7, tn), 0., 1.);

  float cov = lightInk ? tn : 1. - tn;
  cov = pow(cov, exp2(-.9 * p_density));
  cov += .12 * cov * (1. - cov);                        // dot gain

  vec4 B = nz(fc / pr / 170. + vec2(40.5, 11.5));
  float br = (B.r - .5) * cos(ang * 3.) + (B.g - .5) * sin(ang * 3.);
  cov += br * .45 * p_breathe * cov * (1. - cov);

  cov *= 1. - base.g;                                   // vignette -> bare paper
  bool flood = inkLight != dark;                        // headline: toward light in the light theme, dark in the dark
  cov = mix(cov, flood ? 1. : 0., (flood ? .9 : .78) * base.b);
  cov = clamp(cov, 0., 1.) * .92;                       // the densest ink keeps a few paper specks

  // 1 device px grain
  ivec2 tile = ip >> 8;
  vec4 F = texelFetch(u_noiseTexture, (ip + ivec2(tile.x * 73 + tile.y * 151, tile.x * 197 + tile.y * 89)) & 255, 0);
  float a1 = ang * 7. + B.b * TAU;
  float n = (F.r - .5) * cos(a1) + (F.g - .5) * sin(a1);
  float aa = .07;
  float thr = clamp(.5 + n * 1.15, aa, 1. - aa);
  float inkA = smoothstep(thr - aa, thr + aa, cov) * base.a;

  vec3 pap = paper * (1. + (F.b - .5) * (inkLight ? .035 : .08));
  fragColor = vec4(clamp(mix(pap, ink, inkA), 0., 1.), 1.);
}
