import { ArtifactPreviewImage, MediaFrame } from "@/butler-ds";

export function LibraryImage({ src, alt, preview = false }: { src?: string; alt: string; preview?: boolean }) {
  return preview ? <ArtifactPreviewImage src={src ?? ""} alt={alt} />
    : <MediaFrame src={src} alt={alt} placeholder />;
}
