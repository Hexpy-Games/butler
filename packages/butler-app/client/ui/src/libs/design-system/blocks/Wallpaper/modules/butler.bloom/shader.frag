// Bloom: six soft color blobs drift over a light or dark base.
// Every time term repeats within 200*PI seconds (frequencies are multiples of 0.01 rad/s).
float blob(vec2 p,vec2 c,float radius,vec2 scale){
  vec2 d=p-c;
  d.x*=u_resolution.x/u_resolution.y;
  d*=scale;
  return 1.-smoothstep(0.,radius,length(d));
}

vec2 flow(vec2 p,float t){
  p+=vec2(sin(p.y*3.7+t*.7),cos(p.x*3.1-t*.55))*.045;
  p+=vec2(sin((p.x+p.y)*4.2-t*.48),cos((p.x-p.y)*3.8+t*.42))*.025;
  return p;
}

void main(){
  float t=u_time;
  vec2 p=flow(gl_FragCoord.xy/u_resolution,t);
  vec2 c1=vec2(.22+sin(t*.31)*.5,.22+cos(t*.37)*.42);
  vec2 c2=vec2(.78+cos(t*.42)*.46,.32+sin(t*.29)*.36);
  vec2 c3=vec2(.35+sin(t*.23+2.)*.52,.82+cos(t*.35+1.2)*.35);
  vec2 c4=vec2(.9+cos(t*.36+3.)*.44,.76+sin(t*.44+2.1)*.38);
  vec2 c5=vec2(.52+sin(t*.19+4.8)*.5,.52+cos(t*.25+3.4)*.3);
  vec2 c6=vec2(.5+cos(t*.28+1.7)*.55,.18+sin(t*.21+2.8)*.42);
  float a1=blob(p,c1,.74,vec2(1.55,.74));
  float a2=blob(p,c2,.7,vec2(1.22,.86));
  float a3=blob(p,c3,.76,vec2(1.48,.78));
  float a4=blob(p,c4,.66,vec2(1.1,.92));
  float a5=blob(p,c5,.86,vec2(1.8,.58));
  float a6=blob(p,c6,.72,vec2(1.35,.72));
  float sum=a1+a2+a3+a4+a5+a6;
  vec3 liquid=(p_colors[0]*a1+p_colors[1]*a2+a3*p_colors[2]+p_colors[3]*a4+p_colors[4]*a5*.8+p_colors[5]*a6*.85)
    /max(a1+a2+a3+a4+a5*.8+a6*.85,.001);
  float lift=blob(p,vec2(.43+sin(t*.34)*.28,.34+cos(t*.27)*.2),.42,vec2(1.8,.62))
    +blob(p,vec2(.6+cos(t*.22)*.25,.72+sin(t*.31)*.18),.38,vec2(1.55,.68));
  float veil=smoothstep(.32,1.8,sum)*(1.-smoothstep(.4,1.2,lift)*.36);
  vec3 base=mix(vec3(1.),vec3(.04,.045,.07),u_dark);
  vec3 wash=mix(vec3(.965,.955,1.),vec3(.09,.08,.13),u_dark);
  vec3 color=mix(base,liquid,veil*mix(.46,.38,u_dark));
  color=mix(color,wash,.008);
  fragColor=vec4(color,1.);
}
