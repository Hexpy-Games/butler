import type { DsBaseProps } from "../../lib/dsProps";
import type React from "react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

import { cn } from "../../lib/utils";
import { Label } from "./label";
import { Separator } from "./separator";
import styles from "../../components/Field/Field.module.css";
import { dsClass } from "../../lib/internal";

function FieldSet({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"fieldset">>) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(styles.set, className)}
      {...props} />
  );
}

function FieldLegend({
  className,
  variant = "legend",
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"legend">> & {
  variant?: "legend" | "label";
}) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(styles.legend, className)}
      {...props} />
  );
}

function FieldGroup({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"div">>) {
  return (
    <div
      data-slot="field-group"
      className={cn(styles.group, className)}
      {...props} />
  );
}

const fieldVariants = cva(styles.field, {
  variants: {
    orientation: {
      vertical: "",
      horizontal: "",
      responsive: "",
    },
  },
  defaultVariants: {
    orientation: "vertical",
  },
});

function Field({
  className,
  orientation = "vertical",
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"div">> &
  VariantProps<typeof fieldVariants>) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props} />
  );
}

function FieldContent({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"div">>) {
  return (
    <div
      data-slot="field-content"
      className={cn(styles.content, className)}
      {...props} />
  );
}

function FieldLabel({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof Label>>) {
  return (
    <Label
      data-slot="field-label"
      className={dsClass(styles.label, className)}
      {...props} />
  );
}

function FieldTitle({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"div">>) {
  return (
    <div
      data-slot="field-label"
      className={cn(styles.title, className)}
      {...props} />
  );
}

function FieldDescription({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"p">>) {
  return (
    <p
      data-slot="field-description"
      className={cn(styles.description, className)}
      {...props} />
  );
}

function FieldSeparator({
  children,
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"div">>) {
  return (
    <div
      data-slot="field-separator"
      data-content={!!children}
      className={cn(styles.separator, className)}
      {...props}>
      <Separator className={dsClass(styles.separatorLine)} />
      {children && (
        <span
          className={styles.separatorContent}
          data-slot="field-separator-content">
          {children}
        </span>
      )}
    </div>
  );
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"div">> & {
  errors?: Array<{ message?: ReactNode }>;
}) {
  const content = useMemo(() => {
    if (children) {
      return children;
    }

    if (!errors?.length) {
      return null;
    }

    const uniqueErrors: Array<{ message?: ReactNode }> = [
      ...new Map(errors.map((error) => [error?.message, error])).values(),
    ];

    if (uniqueErrors?.length == 1) {
      return uniqueErrors[0]?.message;
    }

    return (
      <ul className={styles.errorList}>
        {uniqueErrors.map((error, index) =>
          error?.message && <li key={index}>{error.message}</li>)}
      </ul>
    );
  }, [children, errors]);

  if (!content) {
    return null;
  }

  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn(styles.error, className)}
      {...props}>
      {content}
    </div>
  );
}

export {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
};
