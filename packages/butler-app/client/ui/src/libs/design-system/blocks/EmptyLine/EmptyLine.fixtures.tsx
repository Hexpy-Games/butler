import { EmptyLine } from "./EmptyLine";
import { Button } from "../../components/Button";
import { FileText, Plus } from "../../components/Icons";

export function EmptyLineFixture() {
  return (
    <EmptyLine
      icon={<FileText size={32} />}
      message="No sessions yet"
      action={<Button iconStart={<Plus size={16} />} text="Create Session" />}
    />
  );
}
