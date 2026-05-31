import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import {
  NativeSelect,
  NativeSelectOption,
} from "../../components/NativeSelect";
import { Trash2 } from "../../components/Icons";
import { SettingsSecretRow, SettingsSecretRows } from "./SettingsSecretRows";

export function SettingsSecretRowsFixture() {
  const sourceControl = (
    <NativeSelect aria-label="Secret source" size="sm" defaultValue="env">
      <NativeSelectOption value="literal">Literal</NativeSelectOption>
      <NativeSelectOption value="env">ENV</NativeSelectOption>
      <NativeSelectOption value="file">File</NativeSelectOption>
    </NativeSelect>
  );

  return (
    <SettingsSecretRows
      title="Secret headers"
      actions={
        <>
          <NativeSelect
            aria-label="Default source"
            size="sm"
            defaultValue="env"
          >
            <NativeSelectOption value="literal">Literal</NativeSelectOption>
            <NativeSelectOption value="env">ENV</NativeSelectOption>
            <NativeSelectOption value="file">File</NativeSelectOption>
          </NativeSelect>
          <ButtonContainer size="sm">
            <Button size="sm" variant="secondary">
              Apply source
            </Button>
            <Button size="sm" variant="secondary">
              Add row
            </Button>
          </ButtonContainer>
        </>
      }
    >
      <SettingsSecretRow
        sourceControl={sourceControl}
        keyControl={
          <Input aria-label="Secret key" value="AUTH_TOKEN" readOnly />
        }
        valueControl={
          <Input aria-label="Secret value" value="BUTLER_AUTH_TOKEN" readOnly />
        }
        actionControl={
          <IconButton label="Remove secret">
            <Trash2 size={14} />
          </IconButton>
        }
      />
    </SettingsSecretRows>
  );
}
