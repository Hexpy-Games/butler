import * as React from "react";

import { cn } from "../../lib/utils";
import { ChevronDownIcon } from "../../components/Icons";
import styles from "../../components/NativeSelect/NativeSelect.module.css";

function getNodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(getNodeText).join("");
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return getNodeText(node.props.children);
  }
  return "";
}

function getValueString(
  value: React.SelectHTMLAttributes<HTMLSelectElement>["value"],
): string | undefined {
  if (value == null || Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}

function getOptionLabel(
  children: React.ReactNode,
  selectedValue: string | undefined,
): string {
  let firstLabel = "";
  let selectedLabel = "";

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      return;
    }

    if (child.type === NativeSelectOptGroup) {
      const groupLabel = getOptionLabel(
        (child.props as { children?: React.ReactNode }).children,
        selectedValue,
      );
      if (!firstLabel && groupLabel) {
        firstLabel = groupLabel;
      }
      if (!selectedLabel && groupLabel) {
        selectedLabel = groupLabel;
      }
      return;
    }

    const props = child.props as React.OptionHTMLAttributes<HTMLOptionElement>;
    const label = props.label ?? getNodeText(props.children);
    const value = props.value == null ? label : String(props.value);

    if (!firstLabel) {
      firstLabel = label;
    }
    if (selectedValue != null && value === selectedValue) {
      selectedLabel = label;
    }
  });

  return selectedLabel || firstLabel;
}

function NativeSelect({
  children,
  className,
  defaultValue,
  onChange,
  size = "default",
  stretch = false,
  value,
  ...props
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  size?: "default" | "sm";
  stretch?: boolean;
}) {
  const valueString = getValueString(value ?? defaultValue);
  const initialLabel = React.useMemo(
    () => getOptionLabel(children, valueString),
    [children, valueString],
  );
  const [selectedLabel, setSelectedLabel] = React.useState(initialLabel);

  React.useEffect(() => {
    setSelectedLabel(initialLabel);
  }, [initialLabel]);

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const selectedOption = event.currentTarget.selectedOptions.item(0);
    setSelectedLabel(selectedOption?.label ?? selectedOption?.text ?? "");
    onChange?.(event);
  }

  return (
    <div
      className={cn(
        styles.wrapper,
        className,
      )}
      data-slot="native-select-wrapper"
      data-size={size}
      data-stretch={stretch ? "true" : undefined}
    >
      <span
        className={styles.trigger}
        data-slot="native-select-trigger"
        data-size={size}
      >
        <span className={styles.value} data-slot="native-select-value">
          {selectedLabel}
        </span>
      </span>
      <select
        className={styles.select}
        data-slot="native-select"
        data-size={size}
        defaultValue={defaultValue}
        onChange={handleChange}
        value={value}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon
        aria-hidden="true"
        className={styles.icon}
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({
  className,
  ...props
}: React.OptionHTMLAttributes<HTMLOptionElement>) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

function NativeSelectOptGroup({
  className,
  ...props
}: React.OptgroupHTMLAttributes<HTMLOptGroupElement>) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
