import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Button,
  Grid,
  Section,
  Stack,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Typo,
  designSystemBlocks,
  designSystemComponents,
  designSystemTokenGroups,
} from "@/butler-ds";
import styles from "./DesignSystemWorkbench.module.css";

type WorkbenchTheme = "system" | "light" | "dark";
type ViewerTab = "tokens" | "primitives" | "blocks";
type ColumnCount = 1 | 2 | 4;

type FixtureItem = {
  name: string;
  path: string;
  tags: string[];
  fixture: () => ReactNode;
};

type SelectedItem =
  | { type: "tokens"; name: string }
  | { type: "primitives" | "blocks"; name: string };

const readmeModules = {
  ...import.meta.glob<string>("../components/*/README.md", {
    eager: true,
    import: "default",
    query: "?raw",
  }),
  ...import.meta.glob<string>("../blocks/*/README.md", {
    eager: true,
    import: "default",
    query: "?raw",
  }),
};

function readmeFor(path: string): string {
  return readmeModules[`../${path}/README.md`] ?? "README guidance is not available yet.";
}

function tokenPreviewStyle(token: { name: string; value: string; kind: string }) {
  const style = { "--token-preview": token.value } as CSSProperties & Record<string, string>;
  if (token.kind === "type") {
    style[token.name.includes("weight") ? "--token-font-weight" : "--token-font-size"] = token.value;
  }
  return style;
}

function tokenPreviewClassName(kind: string): string {
  return [styles.tokenPreview, styles[`token-${kind}`]].filter(Boolean).join(" ");
}

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(SYSTEM_DARK_QUERY).matches
  );
}

function useSystemThemePreference(): boolean {
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return undefined;
    }

    const media = window.matchMedia(SYSTEM_DARK_QUERY);
    const handleChange = () => setPrefersDark(media.matches);
    handleChange();
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return prefersDark;
}

function resolveViewerTheme(theme: WorkbenchTheme, prefersDark: boolean): "dark" | "light" {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return prefersDark ? "dark" : "light";
}

function useViewerTheme(theme: WorkbenchTheme) {
  const systemPrefersDark = useSystemThemePreference();
  const themeClass = `theme-${resolveViewerTheme(theme, systemPrefersDark)}`;

  useEffect(() => {
    const themeClasses = ["theme-light", "theme-dark"];
    document.body.classList.remove(...themeClasses);
    document.body.classList.add(themeClass, "sidebar-translucent");
    return () => {
      document.body.classList.remove(...themeClasses, "sidebar-translucent");
    };
  }, [themeClass]);

  return themeClass;
}

function MarkdownGuide({ markdown }: { markdown: string }) {
  return (
    <Stack className={styles.guide} gap="2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <Typo.H3>{children}</Typo.H3>,
          h2: ({ children }) => <Typo.PanelSectionTitle>{children}</Typo.PanelSectionTitle>,
          h3: ({ children }) => <Typo.PanelSectionTitle>{children}</Typo.PanelSectionTitle>,
          p: ({ children }) => <Typo.Body className={styles.guideParagraph}>{children}</Typo.Body>,
          li: ({ children }) => <li className={styles.guideListItem}>{children}</li>,
          ul: ({ children }) => <ul className={styles.guideList}>{children}</ul>,
          ol: ({ children }) => <ol className={styles.guideList}>{children}</ol>,
          code: ({ children }) => <Typo.Code>{children}</Typo.Code>,
          pre: ({ children }) => <pre className={styles.guideCodeBlock}>{children}</pre>,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </Stack>
  );
}

function ColumnControl({
  value,
  onChange,
}: {
  value: ColumnCount;
  onChange: (value: ColumnCount) => void;
}) {
  return (
    <Stack align="row" className={styles.columnSwitch} gap="1" aria-label="List columns">
      {([1, 2, 4] as const).map((count) => (
        <Button
          aria-pressed={value === count}
          key={count}
          onClick={() => onChange(count)}
          size="sm"
          type="button"
          variant={value === count ? "default" : "outline"}
        >
          {count}
        </Button>
      ))}
    </Stack>
  );
}

function TokenCard({
  group,
  onOpen,
}: {
  group: (typeof designSystemTokenGroups)[number];
  onOpen: () => void;
}) {
  return (
    <Section className={styles.item} contentClassName={styles.tokenList} title={group.name}>
      <button className={styles.itemButton} onClick={onOpen} type="button">
        <Typo.Code>{group.tokens.length} tokens</Typo.Code>
        <Typo.Caption>Open token guidance</Typo.Caption>
      </button>
      {group.tokens.map((token) => (
        <TokenRow key={token.name} token={token} />
      ))}
    </Section>
  );
}

function TokenRow({ token }: { token: { name: string; value: string; kind: string } }) {
  return (
    <Stack
      align="row"
      className={styles.tokenRow}
      cross="center"
      data-ds-token-kind={token.kind}
      data-ds-token-name={token.name}
      gap="3"
    >
      <Stack as="span" aria-hidden="true" className={tokenPreviewClassName(token.kind)} style={tokenPreviewStyle(token)}>
        {token.kind === "type" ? "Aa" : null}
      </Stack>
      <Stack gap="1">
        <Typo.Code>{token.name}</Typo.Code>
        <Typo.Caption>{token.value}</Typo.Caption>
      </Stack>
    </Stack>
  );
}

function FixtureCard({
  component,
  onOpen,
}: {
  component: FixtureItem;
  onOpen: () => void;
}) {
  return (
    <Section
      className={styles.item}
      contentClassName={styles.itemContent}
      data-ds-component={component.name}
      title={component.name}
      description={<Typo.Code>{component.path}</Typo.Code>}
    >
      <button className={styles.itemButton} onClick={onOpen} type="button">
        <TagList tags={component.tags} />
        <Typo.Caption>Open details</Typo.Caption>
      </button>
      <Stack className={styles.fixture}>
        <div className={styles.fixtureCanvas} data-ds-fixture-canvas>
          {component.fixture()}
        </div>
      </Stack>
    </Section>
  );
}

function TagList({ tags }: { tags: string[] }) {
  return (
    <Stack align="row" className={styles.tags} gap="1" wrap>
      {tags.map((tag) => (
        <Typo.Caption className={styles.tag} key={tag}>{tag}</Typo.Caption>
      ))}
    </Stack>
  );
}

function FixtureGrid({
  items,
  columns,
  label,
  type,
  onOpen,
}: {
  items: FixtureItem[];
  columns: ColumnCount;
  label: string;
  type: "primitives" | "blocks";
  onOpen: (item: SelectedItem) => void;
}) {
  return (
    <Grid className={`${styles.grid} ${styles[`columns-${columns}`]}`} gap="4" aria-label={label}>
      {items.map((component) => (
        <FixtureCard component={component} key={component.name} onOpen={() => onOpen({ type, name: component.name })} />
      ))}
    </Grid>
  );
}

function DetailPage({
  selected,
  onBack,
}: {
  selected: SelectedItem;
  onBack: () => void;
}) {
  const item = selected.type === "tokens"
    ? null
    : [...designSystemComponents, ...designSystemBlocks].find((entry) => entry.name === selected.name);
  const tokenGroup = selected.type === "tokens"
    ? designSystemTokenGroups.find((group) => group.name === selected.name)
    : null;

  return (
    <Stack className={styles.detailPage} gap="4">
      <Stack align="row">
        <Button size="sm" variant="outline" onClick={onBack}>Back to list</Button>
      </Stack>
      {item ? <ComponentDetail item={item} /> : null}
      {tokenGroup ? <TokenDetail group={tokenGroup} /> : null}
    </Stack>
  );
}

function ComponentDetail({ item }: { item: FixtureItem }) {
  return (
    <Stack gap="4" data-ds-detail={item.name}>
      <Section className={styles.panel} title={item.name} description={<Typo.Code>{item.path}</Typo.Code>}>
        <TagList tags={item.tags} />
      </Section>
      <PreviewCases item={item} />
      <Section className={styles.panel} title="Guidance">
        <MarkdownGuide markdown={readmeFor(item.path)} />
      </Section>
    </Stack>
  );
}

function PreviewCases({ item }: { item: FixtureItem }) {
  const cases = [
    ["Compact", styles.caseCompact],
    ["App size", styles.caseApp],
    ["Wide", styles.caseWide],
  ] as const;

  return (
    <Grid className={styles.caseGrid} gap="3">
      {cases.map(([label, className]) => (
        <Section className={styles.casePanel} key={label} title={label}>
          <div className={styles.caseContent}>
            <div className={className}>{item.fixture()}</div>
          </div>
        </Section>
      ))}
    </Grid>
  );
}

function TokenDetail({ group }: { group: (typeof designSystemTokenGroups)[number] }) {
  return (
    <Stack gap="4" data-ds-token-detail={group.name}>
      <Section className={styles.panel} title={group.name} description="Canonical values from Butler design-system tokens.css">
        <Typo.Caption>{group.tokens.length} registered tokens</Typo.Caption>
      </Section>
      <Grid className={`${styles.tokenGrid} ${styles["columns-2"]}`} gap="3">
        {group.tokens.map((token) => <TokenRow key={token.name} token={token} />)}
      </Grid>
    </Stack>
  );
}

export function DesignSystemWorkbench() {
  const [theme, setTheme] = useState<WorkbenchTheme>("system");
  const [activeTab, setActiveTab] = useState<ViewerTab>("tokens");
  const [columns, setColumns] = useState<Record<ViewerTab, ColumnCount>>({ tokens: 2, primitives: 2, blocks: 2 });
  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const themeClass = useViewerTheme(theme);
  const selectedColumn = columns[activeTab];

  const tabSummary = useMemo(() => ({
    tokens: `${designSystemTokenGroups.length} token groups`,
    primitives: `${designSystemComponents.length} primitives`,
    blocks: `${designSystemBlocks.length} blocks`,
  }), []);

  useEffect(() => {
    document.querySelector<HTMLElement>("[data-ds-workbench]")?.scrollTo({ top: 0 });
  }, [activeTab, selected]);

  return (
    <Stack
      as="main"
      className={`${styles.workbench} ${themeClass} sidebar-translucent`}
      data-ds-workbench
      gap="2xl"
    >
      <WorkbenchHeader theme={theme} onThemeChange={setTheme} />
      {selected ? (
        <DetailPage selected={selected} onBack={() => setSelected(null)} />
      ) : (
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ViewerTab)} className={styles.tabs}>
          <Stack align="row" className={styles.toolbar} gap="3" justify="between">
            <TabsList>
              <TabsTrigger value="tokens" data-ds-view-tab="tokens">Design Tokens</TabsTrigger>
              <TabsTrigger value="primitives" data-ds-view-tab="primitives">Primitives</TabsTrigger>
              <TabsTrigger value="blocks" data-ds-view-tab="blocks">Blocks</TabsTrigger>
            </TabsList>
            <ColumnControl value={selectedColumn} onChange={(value) => setColumns((state) => ({ ...state, [activeTab]: value }))} />
          </Stack>
          <Typo.Body className={styles.deck}>{tabSummary[activeTab]}</Typo.Body>
          <TabsContent value="tokens">
            <Grid className={`${styles.grid} ${styles[`columns-${columns.tokens}`]}`} gap="4">
              {designSystemTokenGroups.map((group) => <TokenCard group={group} key={group.name} onOpen={() => setSelected({ type: "tokens", name: group.name })} />)}
            </Grid>
          </TabsContent>
          <TabsContent value="primitives">
            <FixtureGrid items={designSystemComponents} columns={columns.primitives} label="Design system primitive fixtures" type="primitives" onOpen={setSelected} />
          </TabsContent>
          <TabsContent value="blocks">
            <FixtureGrid items={designSystemBlocks} columns={columns.blocks} label="Design system block fixtures" type="blocks" onOpen={setSelected} />
          </TabsContent>
        </Tabs>
      )}
    </Stack>
  );
}

function WorkbenchHeader({
  theme,
  onThemeChange,
}: {
  theme: WorkbenchTheme;
  onThemeChange: (theme: WorkbenchTheme) => void;
}) {
  return (
    <Stack as="header" className={styles.header} gap="4">
      <Stack gap="2">
        <Typo.H1>Butler DS Viewer</Typo.H1>
        <Typo.Body className={styles.deck}>Public design-system fixtures rendered with Butler tokens and glass surfaces.</Typo.Body>
      </Stack>
      <Stack align="row" className={styles.themeSwitch} gap="1" aria-label="Preview theme">
        {(["system", "light", "dark"] as const).map((option) => (
          <Button aria-pressed={theme === option} key={option} onClick={() => onThemeChange(option)} size="sm" type="button" variant={theme === option ? "default" : "outline"}>
            {option}
          </Button>
        ))}
      </Stack>
    </Stack>
  );
}
