export const VERTEX_SHADER =
  "attribute vec2 a;varying vec2 v;void main(){v=a*.5+.5;gl_Position=vec4(a,0.,1.);}";

export const BLOOM_FRAGMENT_SHADER = `
precision mediump float;uniform float u;uniform float d;uniform vec2 r;uniform vec3 p0;uniform vec3 p1;uniform vec3 p2;uniform vec3 p3;uniform vec3 p4;uniform vec3 p5;varying vec2 v;
float blob(vec2 p,vec2 c,float radius,vec2 scale){vec2 d=p-c;d.x*=r.x/r.y;d*=scale;return 1.-smoothstep(0.,radius,length(d));}
vec2 flow(vec2 p,float t){p+=vec2(sin(p.y*3.7+t*.7),cos(p.x*3.1-t*.55))*.045;p+=vec2(sin((p.x+p.y)*4.2-t*.48),cos((p.x-p.y)*3.8+t*.42))*.025;return p;}
void main(){float t=u*.001;vec2 p=flow(v,t);
vec2 c1=vec2(.22+sin(t*.31)*.5,.22+cos(t*.37)*.42);vec2 c2=vec2(.78+cos(t*.42)*.46,.32+sin(t*.29)*.36);
vec2 c3=vec2(.35+sin(t*.23+2.)*.52,.82+cos(t*.35+1.2)*.35);vec2 c4=vec2(.9+cos(t*.36+3.)*.44,.76+sin(t*.44+2.1)*.38);
vec2 c5=vec2(.52+sin(t*.19+4.8)*.5,.52+cos(t*.25+3.4)*.3);vec2 c6=vec2(.5+cos(t*.28+1.7)*.55,.18+sin(t*.21+2.8)*.42);
float a1=blob(p,c1,.74,vec2(1.55,.74));float a2=blob(p,c2,.7,vec2(1.22,.86));float a3=blob(p,c3,.76,vec2(1.48,.78));
float a4=blob(p,c4,.66,vec2(1.1,.92));float a5=blob(p,c5,.86,vec2(1.8,.58));float a6=blob(p,c6,.72,vec2(1.35,.72));
float sum=a1+a2+a3+a4+a5+a6;vec3 liquid=(p0*a1+p1*a2+a3*p2+p3*a4+p4*a5*.8+p5*a6*.85)/max(a1+a2+a3+a4+a5*.8+a6*.85,.001);
float lift=blob(p,vec2(.43+sin(t*.34)*.28,.34+cos(t*.27)*.2),.42,vec2(1.8,.62))+blob(p,vec2(.6+cos(t*.22)*.25,.72+sin(t*.31)*.18),.38,vec2(1.55,.68));
float veil=smoothstep(.32,1.8,sum)*(1.-smoothstep(.4,1.2,lift)*.36);vec3 base=mix(vec3(1.),vec3(.04,.045,.07),d);
vec3 wash=mix(vec3(.965,.955,1.),vec3(.09,.08,.13),d);vec3 color=mix(base,liquid,veil*mix(.46,.38,d));
color=mix(color,wash,.008);gl_FragColor=vec4(color,1.);}
`;

export const SILK_FRAGMENT_SHADER = `
precision highp float;uniform float u;uniform float d;uniform vec3 p0;varying vec2 v;
float silkNoise(vec2 p){vec2 q=2.71828*sin(2.71828*p);return fract(q.x*q.y*(1.+p.x));}
vec2 rotateSilk(vec2 p,float a){float c=cos(a);float s=sin(a);return mat2(c,-s,s,c)*p;}
void main(){float t=u*.001;float rnd=silkNoise(gl_FragCoord.xy);vec2 uv=(v-.5)*.9+.5;vec2 tex=rotateSilk(uv,2.7708)*1.06;float phase=t*.64;
tex.y+=.03*sin(3.*tex.x-phase);tex.x+=.015*sin(2.*tex.y+phase*.5);
float fold=.94+.06*sin(2.5*(tex.x+tex.y+cos(1.5*tex.x+2.5*tex.y)+.02*phase)+sin(10.*(tex.x+tex.y-.1*phase)));
float drift=.92+.08*sin(1.2*(tex.x-tex.y)+phase*.18);float highlight=smoothstep(.78,1.,fold);
vec3 shade=mix(vec3(.72,.72,.74),vec3(.34,.35,.38),d);vec3 shine=mix(vec3(1.),vec3(.56,.58,.62),d);
float shadow=1.-smoothstep(.88,.99,fold*drift);vec3 color=mix(p0,shade,shadow*.42);
color=mix(color,shine,highlight*.18);color=mix(color,p0,.14);color-=rnd*.006;gl_FragColor=vec4(color,1.);}
`;
