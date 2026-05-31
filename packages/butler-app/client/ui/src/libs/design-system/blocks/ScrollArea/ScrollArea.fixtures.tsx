import { Typo } from "../../components/Typo";
import { ScrollArea } from "./ScrollArea";

export function ScrollAreaFixture() {
  return (
    <ScrollArea style={{ height: "180px", width: "280px" }}>
      {Array.from({ length: 12 }, (_, index) => (
        <Typo.Body key={index}>Scrollable row {index + 1}</Typo.Body>
      ))}
    </ScrollArea>
  );
}
