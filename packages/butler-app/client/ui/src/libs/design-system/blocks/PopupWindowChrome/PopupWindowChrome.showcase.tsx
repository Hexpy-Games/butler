import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Box } from "../../components/Box";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Field, FieldLabel } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { Minus, Square, X } from "../../components/Icons";
import { Input } from "../../components/Input";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import fixtures from "../BrowserPane/fixtures/fixtures.module.css";
import { PopupWindowChrome } from "./PopupWindowChrome";

export const meta: ShowcaseMeta = {
  title: "PopupWindowChrome",
  category: "Browser",
  tags: ["browser", "pop-up", "window", "sign-in", "titlebar", "traffic lights"],
  status: "beta",
};

const COPY = {
  "en-US": { secure: "Secure connection", insecure: "Not secure", signIn: "Sign in to continue", email: "Email", next: "Next", minimize: "Minimize window", maximize: "Maximize window", close: "Close window" },
  "ko-KR": { secure: "안전한 연결", insecure: "주의 요함", signIn: "계속하려면 로그인하세요", email: "이메일", next: "다음", minimize: "창 최소화", maximize: "창 최대화", close: "창 닫기" },
} as const;

/** The pop-up's page (a sign-in form), standing in for the native view. */
function SignInPage({ locale }: ShowcaseRenderContext) {
  const copy = COPY[locale];
  return (
    <Box padding="xl">
      <Stack gap="lg">
        <Typo.PanelTitle>{copy.signIn}</Typo.PanelTitle>
        <Field><FieldLabel htmlFor={`popup-email-${locale}`}>{copy.email}</FieldLabel><Input id={`popup-email-${locale}`} defaultValue="name@example.com" /></Field>
        <ButtonContainer size="sm" justify="end"><Button size="sm" text={copy.next} /></ButtonContainer>
      </Stack>
    </Box>
  );
}

/** A 400×540 window as the OS draws it (the lights are the OS's; drawn here for the preview). */
function PopupWindow({ context, platform, secure = true }: { context: ShowcaseRenderContext; platform: "darwin" | "win32"; secure?: boolean }) {
  const copy = COPY[context.locale];
  return (
    <div className={fixtures.window} style={{ width: 400, maxWidth: "100%", height: 540 }}>
      {platform === "darwin" ? <span className={fixtures.lights} aria-hidden="true"><span /><span /><span /></span> : null}
      <PopupWindowChrome host="id.example.com" secure={secure} securityLabel={secure ? copy.secure : copy.insecure} platform={platform}
        windowControls={(
          <ButtonContainer size="icon-sm">
            <IconButton label={copy.minimize}><Minus size="md" /></IconButton>
            <IconButton label={copy.maximize}><Square size="md" /></IconButton>
            <IconButton label={copy.close}><X size="md" /></IconButton>
          </ButtonContainer>
        )}>
        <SignInPage {...context} />
      </PopupWindowChrome>
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "macOS pop-up window", render: (context) => <PopupWindow context={context} platform="darwin" /> },
  { name: "Windows pop-up window", render: (context) => <PopupWindow context={context} platform="win32" /> },
  { name: "Not secure", render: (context) => <PopupWindow context={context} platform="darwin" secure={false} /> },
];
