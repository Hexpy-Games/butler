export class GuidedEffectProcessReplacementError extends Error {
  constructor() {
    super(
      "Durable effect requires process replacement before this turn can be finalized.",
    );
    this.name = "GuidedEffectProcessReplacementError";
  }
}
