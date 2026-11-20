import { useMemo } from "react";
import { Linking, Platform, ScrollView, View } from "react-native";
import { marked, type Token, type Tokens } from "marked";
import { RADIUS } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { BaseText } from "./internal/BaseText";
import { fontFace, textStyle, toneColors, weightValue } from "./internal/typography";
import { Text, type TextTone } from "./Text";

const CODE_FONT = Platform.select({ ios: "Menlo", default: "monospace" });

export function Markdown({ text }: { text: string }) {
  const tokens = useMemo(() => marked.lexer(text, { gfm: true }), [text]);
  return <Blocks tokens={tokens} />;
}

export function CodeBlock({ code, inset, tone = "primary" }: { code: string; inset?: boolean; tone?: TextTone }) {
  const t = useTokens();
  return <View style={{ backgroundColor: t.color(inset ? "--color-surface-base" : "--color-surface-raised-opaque"), borderRadius: t.length(RADIUS), padding: t.length("--space-3") }}>
    <ScrollView horizontal><BaseText selectable style={{ ...textStyle(t, "body"),
      fontFamily: CODE_FONT, fontSize: t.length("--typo-code-size"), lineHeight: t.length("--typo-code-line-height"),
      color: t.color(toneColors[tone === "inherit" ? "primary" : tone]),
    }}>{code}</BaseText></ScrollView>
  </View>;
}

function Inline({ tokens }: { tokens: Token[] }) {
  const t = useTokens();
  return tokens.map((generic, index) => {
    const token = generic as Tokens.Generic;
    const children = token.tokens ? <Inline tokens={token.tokens} /> : token.text ?? token.raw;
    switch (token.type) {
      case "br": return "\n";
      case "strong": return <BaseText key={index} selectable style={{ fontFamily: fontFace(weightValue(t, "semibold")) }}>{children}</BaseText>;
      case "em": return <BaseText key={index} selectable style={{ fontStyle: "italic" }}>{children}</BaseText>;
      case "codespan": return <BaseText key={index} selectable style={{ fontFamily: CODE_FONT, backgroundColor: t.color("--color-surface-raised-opaque") }}>{token.text}</BaseText>;
      case "del": return <BaseText key={index} selectable style={{ textDecorationLine: "line-through" }}>{children}</BaseText>;
      case "link":
      case "image": {
        const href = token.href as string;
        const allowed = /^https?:/i.test(href);
        return <BaseText key={index} selectable accessibilityRole={allowed ? "link" : undefined}
          style={allowed ? { color: t.color("--accent-text") } : undefined}
          onPress={allowed ? () => { void Linking.openURL(href); } : undefined}>
          {token.type === "image" ? token.text : children}
        </BaseText>;
      }
      default: return <BaseText key={index} selectable>{children}</BaseText>;
    }
  });
}

function Blocks({ tokens, tone = "primary" }: { tokens: Token[]; tone?: TextTone }) {
  const t = useTokens();
  return <View style={{ gap: t.length("--space-3") }}>
    {tokens.filter(token => token.type !== "space").map((token, index) => <Block key={index} token={token} tone={tone} />)}
  </View>;
}

function Block({ token, tone }: { token: Token; tone: TextTone }) {
  const t = useTokens();
  switch (token.type) {
    case "space": return null;
    case "paragraph":
    case "text": return <Text selectable tone={tone}>{token.tokens ? <Inline tokens={token.tokens} /> : token.text}</Text>;
    case "heading": return <Text selectable tone={tone} variant={token.depth === 1 ? "h3" : token.depth === 2 ? "h4" : "h5"}>
      <Inline tokens={token.tokens ?? []} />
    </Text>;
    case "list": return <View style={{ gap: t.length("--space-3"), paddingLeft: t.length("--space-4") }}>
      {(token as Tokens.List).items.map((item, index) => <View key={index} style={{ flexDirection: "row" }}>
        <View style={{ width: t.length("--space-6") }}>
          <Text selectable tone={tone}>{token.ordered ? `${Number(token.start) + index}.` : "•"}</Text>
        </View>
        <View style={{ flex: 1 }}><Blocks tokens={item.tokens} tone={tone} /></View>
      </View>)}
    </View>;
    case "code": return <CodeBlock code={token.text} tone={tone} />;
    case "blockquote": return <View style={{ borderLeftWidth: t.length("--border-hairline") * 3,
      borderColor: t.color("--color-border-strong"), paddingLeft: t.length("--space-3") }}>
      <Blocks tokens={token.tokens ?? []} tone="secondary" />
    </View>;
    case "hr": return <View style={{ height: t.length("--border-hairline"), backgroundColor: t.color("--color-border-strong") }} />;
    case "table": return <Table token={token as Tokens.Table} tone={tone} />;
    default: return <Text selectable tone={tone}>{token.raw}</Text>;
  }
}

function Table({ token, tone }: { token: Tokens.Table; tone: TextTone }) {
  const t = useTokens();
  const line = { width: t.length("--border-hairline"), color: t.color("--color-border-strong") };
  return <ScrollView horizontal><View style={{ flexDirection: "row", borderTopWidth: line.width, borderLeftWidth: line.width, borderColor: line.color }}>
    {token.header.map((header, column) => <View key={column}>
      {[header, ...token.rows.map(row => row[column])].map((cell, row) => <View key={row}
        style={{ padding: t.length("--space-2"), borderRightWidth: line.width, borderBottomWidth: line.width, borderColor: line.color }}>
        <Text selectable tone={tone} weight={row === 0 ? "semibold" : undefined}><Inline tokens={cell.tokens} /></Text>
      </View>)}
    </View>)}
  </View></ScrollView>;
}

/** The words of a Markdown text without its syntax, on one line (list previews). */
export function markdownPlainText(text: string): string {
  const words = (tokens: Token[]): string => tokens.map((generic) => {
    const token = generic as Tokens.Generic;
    if (token.type === "list") return words((token as Tokens.List).items);
    if (token.type === "code" || token.type === "codespan") return token.text;
    if (token.tokens) return words(token.tokens);
    return token.type === "space" || token.type === "hr" ? " " : token.text ?? "";
  }).join(" ");
  return words(marked.lexer(text, { gfm: true })).replace(/\s+/g, " ").trim();
}
