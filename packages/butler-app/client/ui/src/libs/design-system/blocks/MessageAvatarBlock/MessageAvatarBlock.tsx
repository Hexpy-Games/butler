import type { HTMLAttributes, ReactNode } from "react";
import { Bot, UserRound } from "../../components/Icons";
import { cn } from "../../lib/utils";
import styles from "./MessageAvatarBlock.module.css";

export interface MessageAvatarBlockProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "role"> {
  role?: "assistant" | "user" | "system";
  active?: boolean;
  children?: ReactNode;
}

export function MessageAvatarBlock({
  role = "assistant",
  active = false,
  children,
  className,
  ...props
}: MessageAvatarBlockProps) {
  return (
    <span
      className={cn(styles.avatar, styles[role], active && styles.active, className)}
      data-role={role}
      {...props}
    >
      {children ?? (role === "user" ? <UserRound size={15} /> : <Bot size={15} />)}
    </span>
  );
}
