import { TokenInputControl } from "./TokenInputControl";

export function TokenInputControlFixture() {
  return (
    <TokenInputControl
      value="typescript, design-system"
      tokens={["typescript", "design-system"]}
      onChange={() => undefined}
    />
  );
}
