import { AL, RHO, RING_R, RING_W, RR } from "./constants";

/** A GLSL float literal (always with a decimal point). */
const glslFloat = (value: number) => {
  const text = String(Number(value.toFixed(6)));
  return text.includes(".") ? text : `${text}.`;
};

/**
 * The Butler mark as GLSL signed distances, in the 1200 design units of
 * `constants.ts` (centred at 0, y down), for shaders that print the mark (the
 * first-run ink intro). The ribbon is `ribbon-geometry.ts`'s two rounded
 * sectors (Inigo Quilez sdPie minus RHO); the ring is a pen stroke: an arc
 * from 12 o'clock clockwise to a fraction, with round caps, the full band at 1.
 */
export const BUTLER_MARK_SDF_GLSL = `
const float MARK_RR=${glslFloat(RR)},MARK_RHO=${glslFloat(RHO)},MARK_RING_R=${glslFloat(RING_R)},MARK_RING_W=${glslFloat(RING_W)};
const float MARK_SAL=${glslFloat(Math.sin(AL))},MARK_CAL=${glslFloat(Math.cos(AL))},MARK_TAU=6.2831853;
float markPie(vec2 p,float r){p.x=abs(p.x);float l=length(p)-r;float d=clamp(p.x*MARK_SAL+p.y*MARK_CAL,0.,r);
  vec2 q=p-vec2(MARK_SAL,MARK_CAL)*d;return max(l,length(q)*sign(MARK_CAL*p.x-MARK_SAL*p.y));}
float markRibbon(vec2 d){return min(markPie(vec2(d.y,-d.x),MARK_RR),markPie(vec2(d.y,d.x),MARK_RR))-MARK_RHO;}
// 0 at 12 o'clock, growing clockwise (y points down)
float markAngle(vec2 d){return fract(atan(d.x,-d.y)/MARK_TAU+1.);}
float markArc(vec2 d,float pr){
  float band=abs(length(d)-MARK_RING_R)-MARK_RING_W*.5;
  if(pr>=1.)return band;
  if(pr<=0.)return 1e5;
  float th=pr*MARK_TAU;
  float cap=min(length(d-vec2(0.,-MARK_RING_R)),length(d-vec2(sin(th),-cos(th))*MARK_RING_R))-MARK_RING_W*.5;
  return markAngle(d)<=pr?band:cap;
}
`;
