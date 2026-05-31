import { Clickable } from "./Clickable";

export function ClickableFixture() {
  return <Clickable onClick={() => undefined}>Clickable row</Clickable>;
}
