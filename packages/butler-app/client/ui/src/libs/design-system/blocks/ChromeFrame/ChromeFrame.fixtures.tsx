import { Typo } from "../../components/Typo";
import { ChromeFrame } from "./ChromeFrame";

export function ChromeFrameFixture() {
  return (
    <ChromeFrame
      titlebar={<Typo.AppTitle>Butler</Typo.AppTitle>}
      sidebar={<Typo.Caption>Sidebar</Typo.Caption>}
      inspector={<Typo.Caption>Inspector</Typo.Caption>}
      rightOpen
    >
      <Typo.Body>Conversation surface</Typo.Body>
    </ChromeFrame>
  );
}
