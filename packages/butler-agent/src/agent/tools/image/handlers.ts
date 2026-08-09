import { createAnalyzeAttachedImageToolHandler } from "./analyze_attached_image/index.ts";

type ImageToolHandlerInput = Omit<
  Parameters<typeof createAnalyzeAttachedImageToolHandler>[0],
  "verifiedImagePayloadPort"
> & Partial<Pick<
  Parameters<typeof createAnalyzeAttachedImageToolHandler>[0],
  "verifiedImagePayloadPort"
>>;

export function createImageToolHandlers(
  input: ImageToolHandlerInput,
) {
  return {
    analyze_attached_image: createAnalyzeAttachedImageToolHandler({
      butlerData: input.butlerData,
      imageManifests: input.imageManifests,
      imageCarrier: input.imageCarrier,
      imageCapability: input.imageCapability,
      verifiedImagePayloadPort: input.verifiedImagePayloadPort ?? {
        read: async () => {
          throw new Error("verified_image_payload_port_missing");
        },
      },
    }),
  };
}
