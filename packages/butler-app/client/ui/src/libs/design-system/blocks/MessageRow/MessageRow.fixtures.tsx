import { MessageFooter, MessageRow } from "./MessageRow";

export function MessageRowFixture() {
  return (
    <MessageRow
      role="assistant"
      dataTestClass="message assistant"
    >
      <p>Butler response rendered in the reusable message presenter.</p>
      <MessageFooter>
        <button type="button">Copy</button>
        <span>Worked for 00m 09s</span>
      </MessageFooter>
    </MessageRow>
  );
}
