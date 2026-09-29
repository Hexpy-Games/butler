// Grain: film grain over the pre-fitted image, strongest in the midtones;
// optionally black and white. The grain is about 1.5 CSS px at any DPR.
const vec3 LUMA=vec3(.2126,.7152,.0722);

void main(){
  vec3 color=texture(u_image,gl_FragCoord.xy/u_resolution).rgb;
  float luma=dot(color,LUMA);
  color=mix(color,vec3(luma),p_mono);
  vec2 cell=gl_FragCoord.xy/(u_pixelRatio*1.5);
  float fine=texture(u_noiseTexture,(cell+u_seed*256.)/256.).r-.5;
  float coarse=texture(u_noiseTexture,(cell*.5+vec2(97.,31.))/256.).g-.5;
  float midtones=1.-pow(abs(luma-.5)*2.,2.);
  float grain=(fine*.7+coarse*.3)*p_amount*.4*(.35+.65*midtones);
  fragColor=vec4(clamp(color+grain,0.,1.),1.);
}
