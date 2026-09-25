export type FluidVariant = "bloom" | "silk";

/**
 * Exact common period (seconds) of every time-driven term in each shader.
 * Bloom frequencies are multiples of 0.01 rad/s (period 2*PI/0.01); silk
 * frequencies are multiples of 0.0064 rad/s (period 2*PI/0.0064). Wrapping
 * at these periods keeps the animation continuous while the uniform stays
 * small enough for mediump floats.
 */
export const FLUID_TIME_PERIOD_SECONDS: Record<FluidVariant, number> = {
  bloom: 200 * Math.PI,
  silk: 312.5 * Math.PI,
};

export function fluidShaderTime(
  milliseconds: number,
  variant: FluidVariant,
): number {
  const period = FLUID_TIME_PERIOD_SECONDS[variant];
  const seconds = (milliseconds / 1000) % period;
  return seconds < 0 ? seconds + period : seconds;
}
