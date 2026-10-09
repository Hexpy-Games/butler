import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { ButlerThinkingMark } from "../../components/ButlerThinkingMark";
import { Library, Lock } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { AddressField, type AddressFieldLabels } from "./AddressField";

export const meta: ShowcaseMeta = {
  title: "AddressField",
  category: "Browser",
  tags: ["browser", "address", "url", "host", "security", "bookmark", "edit"],
  status: "beta",
};

const COPY: Record<ShowcaseRenderContext["locale"], AddressFieldLabels & { signedIn: string; output: string; library: string; submitted: string }> = {
  "en-US": { field: "Address", placeholder: "Search or enter URL", secure: "Secure connection", insecure: "Not secure", bookmarkAdd: "Add bookmark",
    bookmarked: "Bookmarked", signedIn: "Signed in", output: "Butler output", library: "Library", submitted: "Opens" },
  "ko-KR": { field: "주소", placeholder: "검색 또는 URL 입력", secure: "안전한 연결", insecure: "주의 요함", bookmarkAdd: "북마크 추가",
    bookmarked: "북마크됨", signedIn: "로그인 사용", output: "버틀러 출력물", library: "서랍", submitted: "열기" },
};

const SHOP = "https://shop.example.com/search?q=office-chair";

/** The App container in miniature: click to edit, Enter opens, the star toggles. */
function Live({ locale }: ShowcaseRenderContext) {
  const copy = COPY[locale];
  const [url, setUrl] = useState(SHOP);
  const [bookmarked, setBookmarked] = useState(false);
  return (
    <Stack gap="xs">
      <AddressField url={url} labels={copy} onSubmit={(value) => setUrl(value || url)} bookmarked={bookmarked} onToggleBookmark={() => setBookmarked(!bookmarked)} />
      <Typo.Caption numeric="tabular" tone="secondary">{`${copy.submitted}: ${url}`}</Typo.Caption>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Click to edit (Enter opens, Escape cancels)", states: ["focus-visible", "open"], render: (context) => <Live {...context} /> },
  {
    name: "Security, tags and Butler pages",
    render: ({ locale }) => {
      const copy = COPY[locale];
      return (
        <Stack gap="sm">
          <AddressField url="https://console.example.net/billing/invoices" labels={copy} onSubmit={() => undefined} onToggleBookmark={() => undefined} bookmarked
            tags={<Tag size="sm" tone="accent" icon={<Lock size="xs" />}>{copy.signedIn}</Tag>} />
          <AddressField url="http://intranet.example.com/login" security="insecure" labels={copy} onSubmit={() => undefined} onToggleBookmark={() => undefined} />
          <AddressField url="https://output.butler.local/weekly-summary" security="internal" labels={copy} onSubmit={() => undefined}
            tags={<Tag size="sm" icon={<ButlerThinkingMark size="xs" />}>{copy.output}</Tag>} />
          <AddressField title={copy.library} icon={<Library size="md" />} security="internal" labels={copy} />
          <AddressField labels={copy} onSubmit={() => undefined} />
        </Stack>
      );
    },
  },
  {
    name: "Long address truncates at the end",
    widths: ["320", "375", "app"],
    render: ({ locale }) => (
      <AddressField url="https://docs.example.com/guides/getting-started/installation/configure-the-desktop-app?tab=macos#signing" labels={COPY[locale]}
        onSubmit={() => undefined} onToggleBookmark={() => undefined} />
    ),
  },
  { name: "Disabled (browser off)", states: ["disabled"], render: ({ locale }) => <AddressField labels={COPY[locale]} disabled /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "open", "read-only", "disabled"],
  render: ({ locale, state }) => (
    <AddressField url={SHOP} labels={COPY[locale]} disabled={state === "disabled"} editing={state === "open" ? true : undefined}
      onSubmit={state === "read-only" ? undefined : () => undefined} onToggleBookmark={() => undefined} />
  ),
};
