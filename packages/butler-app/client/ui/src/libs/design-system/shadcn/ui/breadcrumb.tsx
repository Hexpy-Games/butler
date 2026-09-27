import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "../../lib/utils";
import {
  ChevronRightIcon,
  MoreHorizontalIcon,
} from "../../components/Icons";
import styles from "../../components/Breadcrumb/Breadcrumb.module.css";

function Breadcrumb({
  className,
  label,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"nav">> & {
  /** Localized accessible name of the trail (app copy `common.breadcrumb`). */
  label: string;
}) {
  return (
    <nav
      aria-label={label}
      data-slot="breadcrumb"
      className={cn(className)}
      {...props}
    />
  );
}

function BreadcrumbList({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"ol">>) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(styles.list, className)}
      {...props}
    />
  );
}

function BreadcrumbItem({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"li">>) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn(styles.item, className)}
      {...props}
    />
  );
}

function BreadcrumbLink({
  asChild,
  className,
  ...props
}: DsBaseProps<React.AnchorHTMLAttributes<HTMLAnchorElement>> & {
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot : "a";

  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn(styles.link, className)}
      {...props}
    />
  );
}

/** A breadcrumb step that navigates in-app (no URL): a real button styled as a link. */
function BreadcrumbButton({
  className,
  type = "button",
  ...props
}: DsBaseProps<React.ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button
      data-slot="breadcrumb-link"
      type={type}
      className={cn(styles.link, className)}
      {...props}
    />
  );
}

function BreadcrumbPage({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"span">>) {
  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn(styles.page, className)}
      {...props}
    />
  );
}

function BreadcrumbSeparator({
  children,
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"li">>) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn(styles.separator, className)}
      {...props}
    >
      {children ?? <ChevronRightIcon />}
    </li>
  );
}

function BreadcrumbEllipsis({
  className,
  label,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"span">> & {
  /** Localized name of the collapsed steps (app copy `common.more`). */
  label: string;
}) {
  return (
    <span
      data-slot="breadcrumb-ellipsis"
      role="presentation"
      aria-hidden="true"
      className={cn(styles.ellipsis, className)}
      {...props}
    >
      <MoreHorizontalIcon />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbButton,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
};
