// Riso print v9 (butler.riso-print), pass 1: ink density at 1 texel per 4 CSS px, sampled by print.frag as u_density.
// Everything from colSd() to the end of risoDensity() is the approved v9 density.frag verbatim
// (spec-riso-dynamic-wallpaper appendix); only the interface is the engine's: main() binds the prototype's
// uniforms from engine uniforms (u_noiseTexture is the print's own noise for density modules) and the output is fragColor.
vec2 uDRes, uCss, uSeed; float uFlow, uMis, uNight, uComp; vec4 uDrop, uKeep, uKeep2, uCol; vec3 uW;
#define uNoise u_noiseTexture

// Column limit (v8, owner decision (i) 2026-10-11): only the faint tail of a soft fade may enter the message column.
// uCol = (left, right, top, on) in CSS px. Inside the column ink density is capped at 25%, falling to 0 by 90 px inside;
// the cap opens to 1 over 120 px outside the column. The dense core of every mass stays outside.
float colSd(vec2 p){float sx=max(uCol.x-p.x,p.x-uCol.y),t=uCol.z-p.y;return t>0.?max(sx,t):sx;}   // > 0 outside, < 0 inside (sides only below the top)
float colCap(float sd,float k){return mix(.25*smoothstep(-90.*k,0.,sd),1.,smoothstep(0.,120.*k,sd));}   // k: window scale
vec4 nz(vec2 x);
// v7 composition behind a conversation: the rev 3 field shows only inside a few organic ink masses beside the content
// (no full-height bands). All shaping happens here, in the quarter-res density pass, so it goes through the same soft-edge
// pipeline as rev 3 (diffusion, soak, dot-size fade). Every mass edge is a wide ramp: outer edges 300 px smoothstep,
// column-facing edges a linear ramp of 380-560 px starting 20-110 px INSIDE the column (v8), so only its faint tail enters; nothing is narrower than rev 3.
// Window scale (v8, decision (j)): the same composition at every width. k = 1 at the 1440 card (1125 x 900), about .57 on a phone.
float kScale(vec2 R){return clamp(sqrt(R.x*R.y)/1006.,.45,1.2);}
float blob(vec2 p,vec2 c,float r,float warp,float k){return 1.-smoothstep(r-150.*k,r+150.*k,length(p-c)+warp);}
float masses(vec2 p,vec2 R,vec4 w,vec4 n,float ft){
  // Masses sit on corners and bleed off two edges at once, so no edge of the card carries a long straight band.
  float k=kScale(R),H=R.y,W=R.x,S=k*1006.,warp=(w.x-.5)*160.*k; vec2 dr=vec2(sin(ft*.9),cos(ft*.7))*28.*k; float m=0.;
  if(uComp<.5){        // Masses: a large bloom low-left, a smaller one high-right, a small pool low-right
    m=max(m,blob(p,vec2(.02*W,H-.02*S)+dr,.41*S,warp,k));
    m=max(m,blob(p,vec2(W-.01*S,.054*S)-dr,.30*S,warp,k));
    m=max(m,.75*blob(p,vec2(W,H-.13*S)+dr.yx,.14*S,warp,k));
  } else if(uComp<1.5){ // Corners: four corner presences of different sizes
    m=max(m,blob(p,vec2(0.,H)+dr,.32*S,warp,k));
    m=max(m,blob(p,vec2(W,0.)-dr,.27*S,warp,k));
    m=max(m,.85*blob(p,vec2(0.)+dr.yx,.16*S,warp,k));
    m=max(m,.85*blob(p,vec2(W,H)-dr.yx,.20*S,warp,k));
  } else {             // Low tide: ink pools in the bottom corners, paper above
    m=max(m,blob(p,vec2(.02*W,H+.02*S)+dr,.47*S,warp,k));
    m=max(m,blob(p,vec2(W-.02*S,H+.054*S)-dr,.36*S,warp,k));
  }
  float side=step(.5*(uCol.x+uCol.y),p.x);
  float r=.65*nz(vec2(p.y/H*2.6+ft*.06,side*13.7+uSeed.x+3.1)).x+.35*nz(vec2(p.y/H*5.3-ft*.04,side*5.1+uSeed.y)).y;
  float r2=nz(vec2(p.y/H*1.9-ft*.05,side*7.9+uSeed.y+1.7)).z;
  float reach=(-125.+65.*smoothstep(.28,.72,r))*k, ramp=(380.+180.*smoothstep(.25,.75,r2))*k;   // v8: start 60-125 px inside the column (capped there), length 380-560 px (x k)
  return m*clamp((colSd(p)-reach)/ramp,0.,1.);
}
vec4 nz(vec2 x){vec2 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);return texture(uNoise,(i+f+.5)/256.);}
vec4 fbm4(vec2 p){vec4 s=vec4(0.);float a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<4;i++){s+=a*nz(p);p=m*p+vec2(17.3,9.1);a*=.5;}return s/.9375;}
void risoDensity(){
  vec2 R=uCss; vec2 p=vec2(gl_FragCoord.x,uDRes.y-gl_FragCoord.y)/uDRes*R;   // CSS px, top-left origin
  float sc=max(420.,.5*max(R.x,R.y)); vec2 q=(p-.5*R)/sc; float ft=uFlow;
  vec4 w=fbm4(q*1.25+uSeed+vec2(ft*.32,-ft*.21));
  vec2 base=q*2.05+(w.xy-.5)*2.5+uSeed.yx*.7;
  vec4 n=fbm4(base+vec2(1.7,9.2)+ft*vec2(.16,-.11));
  // wide ramps: ink fields fade in over a long run instead of a short edge
  vec3 d=smoothstep(vec3(.32,.34,.33),vec3(.88,.90,.87),n.xyz)*(.9+.42*w.w);
  vec2 cc=uKeep.xy+uKeep.zw*.5;vec2 bq=abs(p-cc)-uKeep.zw*.5;
  float sdC=length(max(bq,0.))+min(max(bq.x,bq.y),0.);
  float keep=smoothstep(-30.,440.,sdC+(w.z-.5)*260.+(n.w-.5)*240.);
  vec2 e=abs(p-.5*R)/(.5*R);
  float rim=smoothstep(.25,1.1,length(e)*.85+(n.w-.5)*.6);
  vec2 c2=uKeep2.xy+uKeep2.zw*.5;vec2 b2=abs(p-c2)-uKeep2.zw*.5;
  float sd2=length(max(b2,0.))+min(max(b2.x,b2.y),0.);
  float keep2=mix(.3,1.,smoothstep(-10.,160.,sd2+(w.y-.5)*80.));
  float sdc=colSd(p), kk=kScale(R), col=mix(1.,colCap(sdc,kk),uCol.w);   // v8: soft cap, not a mask
  keep=mix(keep,masses(p,R,w,n,ft),uCol.w);                       // behind a conversation the masses replace the rev 3 column keep-out
  d*=keep*keep2*mix(.3,1.,rim)*uW*mix(.86,1.,uNight)*(1.-.08*uMis);
  d=mix(d,min(d,vec3(colCap(sdc,kk))),uCol.w);                       // inside the column: only a faint tail, <= 25%
  d*=mix(1.,mix(.15,1.,smoothstep(-40.*kk,80.*kk,sdc)),uCol.w);   // v9: the tail is fainter in the column (x0.37 at the edge, x0.15 deeper); C1-smooth, no step
  if(uDrop.w>0.){
    float pg=uDrop.z; float Rd=14.+160.*(1.-pow(1.-pg,3.));
    float rr=length(p-uDrop.xy)+(w.x-.5)*80.*smoothstep(0.,.35,pg)+(n.y-.5)*30.;
    float fade=uDrop.w*(1.-smoothstep(.45,1.,pg))*smoothstep(.3,.8,keep)*col;
    float core=1.-smoothstep(Rd*.35,Rd,rr);
    float ring=smoothstep(Rd*.45,Rd*.85,rr)*(1.-smoothstep(Rd*.85,Rd*1.2,rr));
    d.z=max(d.z,core*.78*fade); d.x=max(d.x,ring*.45*fade*smoothstep(.15,.4,pg)); d.y=max(d.y,ring*.32*fade*smoothstep(.2,.5,pg));
  }
  fragColor=vec4(clamp(d,0.,1.),1.);
}

// Interface. A content rect in drawing-buffer px (bottom-left origin) as CSS px (top-left origin); none: far away (no keep-out).
vec4 risoCssRect(vec4 r){vec2 s=u_css/u_resolution;return r.z>0.&&r.w>0.?vec4(r.x*s.x,u_css.y-(r.y+r.w)*s.y,r.z*s.x,r.w*s.y):vec4(-9999.,-9999.,0.,0.);}
// Plate weights follow the clock (the prototype's weights(): two ink sets, each plate peaking at its own hour).
vec3 risoWeights(){
  vec3 b=p_inks==1?vec3(.42,.5,1.05):vec3(1.,.86,.9);
  return b*(.84+.16*cos(6.2831853*(u_dayPhase-vec3(.33,.6,.85))));
}
void main(){
  uDRes=u_resolution; uCss=u_css; uSeed=vec2(13.7,41.3)+vec2(3.7,2.3)*p_seed;
  uFlow=u_flow; uMis=u_lift; uNight=p_paper==1?1.:0.; uComp=float(p_composition);
  uDrop=u_drop; uKeep=risoCssRect(u_contentRect); uKeep2=risoCssRect(u_contentRect2); uCol=u_col; uW=risoWeights();
  risoDensity();
}
