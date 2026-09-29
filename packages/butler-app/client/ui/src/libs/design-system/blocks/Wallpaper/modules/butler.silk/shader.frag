// Silk: one folded fabric in the base color, with soft shadows and highlights.
// phase=t*.64; every phase term repeats within 312.5*PI seconds (multiples of 0.0064 rad/s).
float silkNoise(vec2 p){vec2 q=2.71828*sin(2.71828*p);return fract(q.x*q.y*(1.+p.x));}

vec2 rotateSilk(vec2 p,float a){float c=cos(a);float s=sin(a);return mat2(c,-s,s,c)*p;}

void main(){
  float t=u_time;
  float rnd=silkNoise(gl_FragCoord.xy);
  vec2 uv=(gl_FragCoord.xy/u_resolution-.5)*.9+.5;
  vec2 tex=rotateSilk(uv,2.7708)*1.06;
  float phase=t*.64;
  tex.y+=.03*sin(3.*tex.x-phase);
  tex.x+=.015*sin(2.*tex.y+phase*.5);
  float fold=.94+.06*sin(2.5*(tex.x+tex.y+cos(1.5*tex.x+2.5*tex.y)+.02*phase)+sin(10.*(tex.x+tex.y-.1*phase)));
  float drift=.92+.08*sin(1.2*(tex.x-tex.y)+phase*.18);
  float highlight=smoothstep(.78,1.,fold);
  vec3 shade=mix(vec3(.72,.72,.74),vec3(.34,.35,.38),u_dark);
  vec3 shine=mix(vec3(1.),vec3(.56,.58,.62),u_dark);
  float shadow=1.-smoothstep(.88,.99,fold*drift);
  vec3 color=mix(p_base,shade,shadow*.42);
  color=mix(color,shine,highlight*.18);
  color=mix(color,p_base,.14);
  color-=rnd*.006;
  fragColor=vec4(color,1.);
}
