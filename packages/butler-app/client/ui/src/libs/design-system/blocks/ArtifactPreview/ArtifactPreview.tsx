import type {
  HTMLAttributes,
  IframeHTMLAttributes,
  ImgHTMLAttributes,
  ReactNode,
} from "react";
import { cn } from "../../lib/utils";
import styles from "./ArtifactPreview.module.css";

export interface ArtifactPreviewProps extends HTMLAttributes<HTMLDivElement> {
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

export function ArtifactPreviewImage({
  className,
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  return <img className={cn(styles.image, className)} {...props} />;
}

export function ArtifactPreviewFrame({
  className,
  ...props
}: IframeHTMLAttributes<HTMLIFrameElement>) {
  return <iframe className={cn(styles.frame, className)} {...props} />;
}

export function ArtifactPreviewPre({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLPreElement>) {
  return (
    <pre className={cn(styles.pre, className)} {...props}>
      {children}
    </pre>
  );
}
