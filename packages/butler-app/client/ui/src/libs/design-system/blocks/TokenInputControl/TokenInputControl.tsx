import type { InputHTMLAttributes } from "react";
import { Input } from "../../components/Input";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import styles from "./TokenInputControl.module.css";

export interface TokenInputControlProps {
  id?: string;
  value: string;
  placeholder?: string;
  tokens?: string[];
  onChange?: (value: string) => void;
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "value" | "placeholder" | "onChange">;
}

export function TokenInputControl({
  id,
  value,
  placeholder,
  tokens = [],
  onChange,
  inputProps,
}: TokenInputControlProps) {
  return (
    <Stack gap="xs" className={styles.root}>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
        {...inputProps}
      />
      {tokens.length > 0 ? (
        <div className={styles.tokens}>
          {tokens.map((token) => (
            <Typo.Caption className={styles.token} key={token}>{token}</Typo.Caption>
          ))}
        </div>
      ) : null}
    </Stack>
  );
}
