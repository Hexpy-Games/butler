import { createRoot } from "react-dom/client";
import { Box, Button, Stack, Typo, SetupWizardShell, SetupWizardContent } from "@/butler-ds";
import "../src/libs/design-system/tokens.css";

const query = new URLSearchParams(location.search);
document.documentElement.className = `theme-${query.get("theme") ?? "light"}`;
const card = <SetupWizardContent surface="solid"><Typo.AppTitle>Butler</Typo.AppTitle><Typo.Body>시작할 준비가 되었습니다.</Typo.Body><Button>계속</Button></SetupWizardContent>;
createRoot(document.getElementById("root")!).render(query.has("setup")
  ? <SetupWizardShell title="Butler" variant="focus" tone={query.get("theme") === "dark" ? "dark" : "light"}>{card}</SetupWizardShell>
  : <Stack data-viewport="desktop" gap="md"><Box><Typo.AppTitle data-slot="title">Butler</Typo.AppTitle><Typo.Body data-slot="body">Getting ready…</Typo.Body><Typo.Caption data-slot="caption">Taking longer than usual.</Typo.Caption><Button size="sm">Open log</Button></Box></Stack>);
