// The first-run ink intro (Concept A rev 5) as an engine-internal print module: its own density pass (the ink drop
// and bloom, the flow clock, the pen's swirl and pull, ink gathered onto the ring and used up around it, the residue
// and the card keep-out) and the riso print's own print.frag compiled with RISO_INTRO, which adds the mark (the wet
// bead under the nib, the out-of-register wet ring, the drying key ring, the registering bow tie). The maths is the
// approved prototype's (ref-riso-intro-prototype-sources §3) verbatim; only names are the engine's.
import { BUTLER_MARK_SDF_GLSL } from "../../../components/ButlerThinkingMark/thinking-mark/mark-sdf";
import { RISO_PRINT_WALLPAPER } from "../modules";
import type { WallpaperModule } from "../types";

/** Pass 1 at 1 texel per 4 CSS px. The density ramp is widened like the wallpaper (0.41/0.43/0.44 to 0.86). */
const INTRO_DENSITY = `
uniform float uFlow,uBloom,uResidue,uCardOn,uMarkA,uDraw,uDry,uSweep,uClear,uScale;
uniform vec3 uMark,uRing; uniform vec2 uOrigin; uniform vec4 uCard,uPtr;
float hash(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float s=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<4;i++){s+=a*vn(p);p=m*p;a*=.5;}return s;}
const float RING_R=435.,RING_W=74.,TAU=6.2831853;
float angF(vec2 d){return fract(atan(d.x,-d.y)/TAU+1.);}
void main(){
  vec2 p=vec2(gl_FragCoord.x,u_resolution.y-gl_FragCoord.y)/u_resolution*u_css;   // CSS px, top-left origin
  vec2 pd=p-uPtr.xy;float fall=exp(-dot(pd,pd)/12100.);
  vec2 sp=p-uPtr.zw*fall*34.;
  // the pen feeds on the ink: the field is dragged clockwise with the nib and, once the nib has passed, pulled onto the stroke
  float Rp=uRing.z*(RING_R/1200.);
  vec2 rd=sp-uRing.xy;float rl=length(rd)+1e-3;
  float ra=angF(rd);
  float seam=mix(smoothstep(0.,.07,ra),1.,uDry);
  float passed=smoothstep(ra-.02,ra+.1,uSweep)*seam;
  float dl=(rl-Rp)/Rp;
  float G=passed*exp(-dl*dl/1.6)*1.7*(1.-.55*uResidue);
  float sw=-.85*uDraw*exp(-dl*dl/3.2);
  float cs=cos(sw),sn=sin(sw);
  vec2 rdir=mat2(cs,sn,-sn,cs)*(rd/rl);
  float th=uDraw*TAU;vec2 tip=uRing.xy+vec2(sin(th),-cos(th))*Rp;
  float pen=smoothstep(0.,.04,uDraw)*(1.-smoothstep(.94,1.,uDraw));
  vec2 tv=sp-tip;float tf=exp(-dot(tv,tv)/(Rp*Rp*1.6));
  vec2 gp=uRing.xy+rdir*(Rp+(rl-Rp)*(1.+G))+tv*tf*pen*1.2;
  vec2 q=(gp-uOrigin)/uScale;
  float grow=.16+1.05*uBloom;
  vec2 qa=q/grow;
  float ft=uFlow;
  vec2 w=vec2(fbm(qa*1.4+vec2(3.1,ft*.45)),fbm(qa*1.4+vec2(5.2-ft*.35,1.3)));
  float rr=length(qa)+(w.x-.5)*.6;
  float env=1.-smoothstep(.5,1.05,rr);
  vec2 base=qa*2.1+(w-.5)*2.6;
  vec3 n=vec3(fbm(base+vec2(1.7,9.2)+ft*vec2(.18,-.1)),
              fbm(base*1.08+vec2(8.3,2.8)+ft*vec2(-.12,.16)),
              fbm(base*.94+vec2(4.1,6.6)+ft*vec2(.05,.14)));
  vec3 d=smoothstep(vec3(.41,.43,.44),vec3(.86),n)*env;
  d*=vec3(1.,.92,.85);
  // dries to a residue that keeps to the edges, clear of the card
  vec2 cc=uCard.xy+uCard.zw*.5;vec2 bq=abs(p-cc)-uCard.zw*.5;
  float sdC=length(max(bq,0.))+min(max(bq.x,bq.y),0.);
  float edge=smoothstep(60.,360.,sdC+(w.y-.5)*120.);
  d*=mix(1.,.62*edge,uResidue);
  d*=mix(1.,smoothstep(16.,120.,sdC),uCardOn);
  // ink is used up along the written stroke and inside the ring; this travels with the mark
  vec2 md=p-uMark.xy;float ml=length(md);
  float Rm=uMark.z*(RING_R/1200.),Wm=uMark.z*(RING_W/1200.);
  float ma=angF(md);
  float used=smoothstep(ma+.03,ma+.16,uSweep)*mix(smoothstep(0.,.07,ma),1.,uDry);
  float halo=1.-smoothstep(Wm*.5,Wm*.5+Rm*.6,abs(ml-Rm));
  float inner=(1.-smoothstep(Rm*.78,Rm*1.02,ml))*uClear;
  d*=1.-.95*max(used*halo,inner)*uMarkA;
  fragColor=vec4(clamp(d,0.,1.),1.);
}
`;

/** The mark, drawn at full resolution in the print pass and never blurred (prototype FS2). */
const INTRO_MARK = `
#define RISO_INTRO 1
uniform float uMarkA,uBeat,uDraw,uDry,uPlate,uPlateA,uKeyA,uBowS,uIntroNight; uniform vec3 uMark,uRing,uKey;
${BUTLER_MARK_SDF_GLSL}
float markCover(float sd,float aa){return 1.-smoothstep(-aa,aa,sd);}
// the wet bead under the nib, the wet ring (three plates out of register until the key ink dries in), the bow tie plates
vec3 introInk(vec2 p,vec3 d){
  float Rp=uRing.z*(MARK_RING_R/1200.);
  float th=uDraw*MARK_TAU;vec2 tip=uRing.xy+vec2(sin(th),-cos(th))*Rp;
  float pen=smoothstep(0.,.04,uDraw)*(1.-smoothstep(.94,1.,uDraw));
  float Wm=uMark.z*(MARK_RING_W/1200.);
  vec2 bv=p-tip;d=max(d,vec3(.85,.7,1.)*pen*exp(-dot(bv,bv)/(Wm*Wm*.9)));
  vec2 md=p-uMark.xy;float ma=markAngle(md);
  float k=1200./uMark.z,aa=.8*k/u_pixelRatio;
  vec2 m=md*k;
  float wo=smoothstep(uDry-.02,uDry+.07,ma)*(1.-smoothstep(.97,1.,uDry))*14.;
  vec2 misA=vec2(2.6,-1.6),misB=vec2(-2.1,1.9);
  vec3 wet=vec3(markCover(markArc(m+misA*wo,uDraw),aa),markCover(markArc(m+misB*wo,uDraw),aa),markCover(markArc(m,uDraw),aa));
  vec2 off=(1.-uPlate)*vec2(3.,-3.)*(1200./64.);
  float bowB=markCover(markRibbon((m+off)/uBowS)*uBowS,aa)*uPlateA;
  float bowP=markCover(markRibbon((m-off)/uBowS)*uBowS,aa)*uPlateA;
  return max(d,vec3(max(wet.x,bowB),max(wet.y,bowP),wet.z)*uMarkA);
}
// the key ink: the ring drying in behind the nib, then the bow tie printing as the exact filled logo
vec3 introKey(vec2 p,vec3 col){
  vec2 md=p-uMark.xy;float k=1200./uMark.z,aa=.8*k/u_pixelRatio;vec2 m=md*k;
  float keyRing=markCover(markArc(m,uDry),aa)*smoothstep(0.,.025,uDry);
  float keyBow=markCover(markRibbon(m/uBowS)*uBowS,aa)*uKeyA;
  return mix(col,uKey,max(keyRing,keyBow)*uMarkA);
}
`;

/** The print pass of the intro: the riso print.frag (shared code, one dot grid) with the mark hooks and the plate beat. */
const INTRO_MAIN = `
void main(){
  risoBind(uIntroNight>.5);
  uMis=.6*uBeat; uGain=0.; uCol=vec4(0.);
  risoPrint();
}
`;

/** Not in any registry: the engine draws it while a first-run intro holds the canvas. */
export const RISO_INTRO_MODULE: WallpaperModule = {
  manifest: {
    id: "butler.riso-intro", name: { en: "Riso intro", ko: "리소 인트로" }, version: "1.0.0", engine: 1,
    motion: "drift", image: "none", density: true, params: [],
  },
  fragment: [INTRO_MARK, RISO_PRINT_WALLPAPER.fragment, INTRO_MAIN].join("\n"),
  density: INTRO_DENSITY,
};
