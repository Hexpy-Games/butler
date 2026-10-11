// Riso print v9 (butler.riso-print), pass 2: halftone, bleed and paper at full resolution over the density pass.
// Everything from colGate() to the end of risoPrint() is the approved v9 print.frag verbatim
// (spec-riso-dynamic-wallpaper appendix); only the interface is the engine's: main() binds the prototype's
// uniforms from engine uniforms and the paper/ink editions of riso-core.js, and the output is fragColor.
vec2 uRes, uCss; float uPr, uMis, uGain, uNight, uBleed; vec3 uPaper, uA, uB, uC; vec4 uCol;
#define uDen u_density

// Guard (v8): the faint tail may reach 90 px into the column; the diffusion taps and soak halo stop by 130 px inside.
float colGate(vec2 p){float sx=max(uCol.x-p.x,p.x-uCol.y),t=uCol.z-p.y,sd=t>0.?max(sx,t):sx;return mix(1.,smoothstep(-130.,-90.,sd),uCol.w);}
float hash(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
vec3 den(vec2 p){return texture(uDen,vec2(p.x/uCss.x,1.-p.y/uCss.y)).xyz;}
float dotC(vec2 p,float ang,float cell,float d){
  float c=cos(ang),s=sin(ang);vec2 q=mat2(c,-s,s,c)*p/cell;vec2 g=fract(q)-.5;
  float r=sqrt(d*.3183)+.15*smoothstep(.55,1.,d)+.02+uGain*.07;
  float aa=1.1/(cell*uPr)+.022;                                 // dots spread a little into the paper
  return (1.-smoothstep(r-aa,r+aa,length(g)))*smoothstep(.006,.06,d);}  // light ink fades out instead of stopping
void risoPrint(){
  vec2 fc=gl_FragCoord.xy; vec2 p=vec2(fc.x,uRes.y-fc.y)/uPr;
  // diffused field: 5 taps over the 4 px density grid (≈ 12 px soft), then a wide soak halo (≈ 24 px)
  vec3 d=.36*den(p)+.16*(den(p+vec2(6.,2.5))+den(p+vec2(-2.5,6.))+den(p+vec2(-6.,-2.5))+den(p+vec2(2.5,-6.)));
  vec3 h=.25*(den(p+vec2(22.,9.))+den(p+vec2(-9.,22.))+den(p+vec2(-22.,-9.))+den(p+vec2(9.,-22.)));
  float fib=.55*hash(floor(p*.5)+3.)+.45*hash(floor(p*vec2(.22,.9))+11.);   // paper fibres carry the bleed
  vec3 wash=uBleed*smoothstep(.02,.6,max(h,d))*(.45+.55*fib);
  float mo=.6+3.*uMis; vec2 mA=vec2(1.6,-1.)*mo,mB=vec2(-1.3,1.2)*mo;
  vec3 cov=vec3(dotC(p+mA,.2618,6.5,d.x),dotC(p+mB,1.309,6.5,d.y),dotC(p,.7854,6.5,d.z));
  cov*=smoothstep(0.,.12,hash(floor(p*.75)+7.)+.06);           // starvation specks
  cov=max(cov,wash)*colGate(p);
  float tooth=hash(floor(p))-.5;                                // paper tooth in CSS px (DPR-stable)
  vec3 paper=uPaper*(1.+(uNight>.5?.1:.03)*tooth);
  vec3 col;
  if(uNight<.5){vec3 k=cov*.9;col=paper*mix(vec3(1),uA,k.x)*mix(vec3(1),uB,k.y)*mix(vec3(1),uC,k.z);}
  else{vec3 M=mix(vec3(1),uA,cov.x)*mix(vec3(1),uB,cov.y)*mix(vec3(1),uC,cov.z);
    float Un=1.-(1.-cov.x)*(1.-cov.y)*(1.-cov.z);col=mix(paper,M*.86,Un*.9);}
  fragColor=vec4(col,1.);
}

// Interface: two editions of one print (riso-core.js STOCK). Day paper = the lower stop of the light --conversation-bg
// (250 250 248, token --riso-paper-day); night stock 25 28 36 (--riso-paper-night); inks per edition (--riso-ink-*).
void main(){
  bool night=p_paper==1;
  uRes=u_resolution; uCss=u_css; uPr=u_pixelRatio; uMis=u_lift; uGain=u_pulse; uNight=night?1.:0.; uBleed=.16; uCol=u_col;
  uPaper=(night?vec3(25.,28.,36.):vec3(250.,250.,248.))/255.;
  uA=(night?vec3(96.,140.,255.):vec3(0.,120.,191.))/255.;
  uB=(night?vec3(255.,112.,190.):vec3(255.,72.,176.))/255.;
  uC=(night?vec3(150.,96.,236.):vec3(96.,56.,156.))/255.;
  risoPrint();
}
