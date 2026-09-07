import { MessageSquare } from "../Icons";
import { InlineReference } from "./InlineReference";

export function InlineReferenceFixture() {
  return <p>이전 <InlineReference icon={<MessageSquare />}>보험 보장 비교</InlineReference> 내용을 참고해 주세요.</p>;
}
