import type { DsBaseProps } from "../../lib/dsProps";
import type {
  HTMLAttributes,
  IframeHTMLAttributes,
  ImgHTMLAttributes,
  ReactNode,
} from "react";
import { dsStyle } from "../../lib/internal";
import { cn } from "../../lib/utils";
import styles from "./ArtifactPreview.module.css";

export type ArtifactPreviewSurface = "card" | "page";

export interface ArtifactPreviewProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  children: ReactNode;
  /**
   * `card` (default): a bordered box with its own scroll, for a preview inside a panel or dialog.
   * `page`: no box and no inner scroll; the content flows in the host's scroll as a reading page
   * (a docked file viewer). The host gives the reading insets.
   */
  surface?: ArtifactPreviewSurface;
}

export function ArtifactPreview({
  children,
  className,
  surface = "card",
  ...props
}: ArtifactPreviewProps) {
  return (
    <div className={cn(styles.viewer, className)} data-surface={surface === "page" ? "page" : undefined} {...props}>
      {children}
    </div>
  );
}

/** A preview image; with `onClick` (open in a viewer) it shows the zoom-in cursor. */
export function ArtifactPreviewImage({
  className,
  ...props
}: DsBaseProps<ImgHTMLAttributes<HTMLImageElement>>) {
  return <img className={cn(styles.image, className)} data-openable={props.onClick ? "true" : undefined} {...props} />;
}

export interface ArtifactPreviewFrameProps extends DsBaseProps<IframeHTMLAttributes<HTMLIFrameElement>> {
  /**
   * CSS pixel size of content that must show at its own size (a scrap's clipped part, a fixed-size page part).
   * The frame takes exactly this size; ArtifactPreview scrolls when it is larger than the preview.
   */
  intrinsicSize?: { width: number; height: number };
}

export function ArtifactPreviewFrame({
  className,
  intrinsicSize,
  ...props
}: ArtifactPreviewFrameProps) {
  return (
    <iframe
      className={cn(styles.frame, className)}
      data-intrinsic={intrinsicSize ? "" : undefined}
      style={intrinsicSize ? dsStyle({ width: `${intrinsicSize.width}px`, height: `${intrinsicSize.height}px` }) : undefined}
      {...props}
    />
  );
}

export function ArtifactPreviewPre({
  children,
  className,
  ...props
}: DsBaseProps<HTMLAttributes<HTMLPreElement>>) {
  return (
    <pre className={cn(styles.pre, className)} {...props}>
      {children}
    </pre>
  );
}
