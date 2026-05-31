import type { ReactNode, MouseEvent } from "react";
import {
  ButtonContainer,
  type ButtonContainerSize,
} from "../../components/ButtonContainer";
import { cn } from "../../lib/utils";
import styles from "./RowActionCluster.module.css";

export interface RowActionClusterProps {
  /** Action button elements */
  children: ReactNode;
  /** Additional CSS class */
  className?: string;
  /** Shared size for all contained buttons */
  size?: ButtonContainerSize;
}

export function RowActionCluster({
  children,
  className,
  size = "icon-sm",
}: RowActionClusterProps) {
  const handleClick = (event: MouseEvent) => {
    // Stop propagation to prevent row click when clicking actions
    event.stopPropagation();
  };

  return (
    <ButtonContainer
      className={cn(styles.cluster, className)}
      size={size}
      onClick={handleClick}
    >
      {children}
    </ButtonContainer>
  );
}
