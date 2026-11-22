import { ScrollView, View } from "react-native";
import { WebView } from "react-native-webview";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { CodeBlock, Markdown, Spinner, Text, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { useViewerContent } from "./useViewerContent";
import type { ResultTarget } from "./results";

export function ViewerBody({ target }: { target: Exclude<ResultTarget, { kind: "image" }> }) {
  const t = useTokens(), S = getAppCopy(useAppLocale()).settings, M = useMobileCopy();
  const { content, setFailed } = useViewerContent(target, t.color("--color-surface-base"));
  const gutter = t.length("--adaptive-page-gutter");
  if (content.status === "loading") return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Spinner label={S.sectionState.loading} /></View>;
  if (content.status === "failed") return <View style={{ padding: gutter }}><Text tone="danger">{content.message}</Text></View>;
  if (content.status === "markdown" || content.status === "text") return <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: gutter }}>
    {content.status === "markdown" ? <Markdown text={content.text} /> : <CodeBlock code={content.text} />}
  </ScrollView>;
  if (content.status === "web" || content.status === "html") return <WebView source={content.status === "html" ? { html: content.html } : content.source}
    originWhitelist={content.status === "html" ? ["*"] : undefined}
    onMessage={(e) => e.nativeEvent.data === "pdf_failed" && setFailed()} style={{ flex: 1, backgroundColor: t.color("--color-surface-base") }}
    contentInsetAdjustmentBehavior="automatic" startInLoadingState renderLoading={() => <Spinner label={S.sectionState.loading} />} />;
  return <View style={{ padding: gutter }}><Text tone="secondary">{M.outputs.unsupported}</Text></View>;
}
