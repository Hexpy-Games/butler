// Stipple - base pass (cached; no u_time). An image filter (image "optional" -> the user's own photo;
// imageDim "none"; pixelRatio "device" -> rendered at the device pixel ratio so the grain is 1 device px).
// This pass does all the photo-derived work once per input change and packs it for overlay.frag:
//   r = tone  (luma + small chroma lift, de-grain, local contrast, auto-levels, soft S-curve; 1 = light)
//   g = vignette amount (the print thins to bare paper toward edges / corners)
//   b = headline mask (behind the top of u_contentRect)
//   a = riso ink laydown (uneven, static)
// No image -> a soft vertical gradient as the tone.
vec3 img(vec2 fc) { return texture(u_image, fc / u_resolution).rgb; }
float tone(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)) + .12 * (max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b))); }
vec4 nz(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return texture(u_noiseTexture, (i + f + .5) / 256.); }

float headMask(vec2 fc) {
  float pr = max(u_pixelRatio, 1e-3);
  vec2 p = fc / pr, R = u_resolution / pr;
  vec4 cr = u_contentRect / pr;
  if (cr.z < 1. || cr.w < 1.) cr = vec4(R.x * .2, R.y * .42, R.x * .6, R.y * .5);
  float headH = min(cr.w * .45, max(150., cr.w * .36));
  vec2 hb = vec2(cr.z, headH) * .5, hc = vec2(cr.x, cr.y + cr.w - headH) + hb;
  vec2 q = abs(p - hc) - hb + 28.;
  float d = length(max(q, 0.)) + min(max(q.x, q.y), 0.) - 28.;
  return 1. - smoothstep(-30., 130., d);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float pr = max(u_pixelRatio, 1e-3);
  vec2 uv = fc / u_resolution;

  float tn;
  if (u_hasImage > .5) {
    float o = 1.3 * pr, r = 9. * pr;
    float c0 = tone(img(fc));
    float s = tone(img(fc + vec2(o, o * .4))) + tone(img(fc + vec2(-o * .4, o))) + tone(img(fc - vec2(o, o * .4))) + tone(img(fc + vec2(o * .4, -o)));
    float L = mix(c0, s * .25, .6);                     // de-grain: the photo's own noise would fight the stipple
    float S = tone(img(fc + vec2(r, r * .5))) + tone(img(fc + vec2(-r * .5, r))) + tone(img(fc - vec2(r, r * .5))) + tone(img(fc + vec2(r * .5, -r)));
    L += (L - S * .25) * .75;                           // local contrast carves edges out of soft photos
    // auto-levels: mean / std of a fixed 4x4 grid of the visible (cover-fitted) image
    float m = 0., m2 = 0.;
    for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
      float v = tone(texture(u_image, (vec2(i, j) + .5) / 4.).rgb);
      m += v; m2 += v * v;
    }
    m /= 16.; float sd = clamp(sqrt(max(m2 / 16. - m * m, 0.)), .1, .3);
    float lo = clamp(m - 1.3 * sd, 0., .7), hi = clamp(m + 1.7 * sd, lo + .3, 1.);
    tn = clamp((L - lo) / (hi - lo), 0., 1.);
  } else {
    tn = .2 + .4 * smoothstep(0., 1., uv.y);
  }
  tn = mix(tn, tn * tn * (3. - 2. * tn), .7);

  // vignette: mixed ellipse / box distance so edges fade as well as corners; size moves where it starts
  vec2 c = (uv - .5) * 2.;
  float vd = mix(length(c) * .7071, max(abs(c.x), abs(c.y)), .5);
  float r0 = mix(1.05, .15, p_vignetteSize);
  float vig = p_vignette * smoothstep(r0, r0 + .75, vd);

  float lay = .86 + .14 * nz(fc / pr / 170. + vec2(40.5, 11.5)).a;
  fragColor = vec4(tn, vig, headMask(fc), lay);
}
