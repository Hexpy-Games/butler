import type { DsBaseProps } from "../../lib/dsProps";
import type {
  HTMLAttributes,
  IframeHTMLAttributes,
  ImgHTMLAttributes,
  ReactNode,
} from "react";
import { cn } from "../../lib/utils";
import styles from "./ArtifactPreview.module.css";

export interface ArtifactPreviewProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  children: ReactNode;
}

export function ArtifactPreview({
  children,
  className,
  ...props
}: ArtifactPreviewProps) {
  return (
    <div className={cn(styles.viewer, className)} {...props}>
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

export function ArtifactPreviewFrame({
  className,
  ...props
}: DsBaseProps<IframeHTMLAttributes<HTMLIFrameElement>>) {
  return <iframe className={cn(styles.frame, className)} {...props} />;
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
