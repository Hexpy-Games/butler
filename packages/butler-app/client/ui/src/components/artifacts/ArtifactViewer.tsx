import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ArtifactPreview,
  ArtifactPreviewFrame,
  ArtifactPreviewImage,
  ArtifactPreviewPre,
  Button,
  MarkdownContent,
  PanelHeader,
  Stack,
  Typo,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { SessionArtifactSummary } from "@/app/types.ts";
import {
  artifactDescription,
  artifactMeta,
  artifactPreviewMode,
  artifactUrl,
} from "./artifactDisplay";

const MARKDOWN_COMPONENTS: Components = {
  a({ href, children, node: _node, ...props }) {
    if (!href) return <span>{children}</span>;
    return (
      <a {...props} href={href} rel="noreferrer" target="_blank">
        {children}
      </a>
    );
  },
};

export function ArtifactViewer({
  artifact,
  onBack,
}: {
  artifact: SessionArtifactSummary;
  onBack: () => void;
}) {
  const url = artifactUrl(artifact);
  const mode = artifactPreviewMode(artifact);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");

  useEffect(() => {
    if (!url || (mode !== "markdown" && mode !== "text")) return;
    const controller = new AbortController();
    setState("loading");
    fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Artifact fetch failed.");
        return response.text();
      })
      .then((body) => {
        setText(body);
        setState("idle");
      })
      .catch((error: unknown) => {
        if ((error as Error).name !== "AbortError") setState("failed");
      });
    return () => controller.abort();
  }, [mode, url]);

  const meta = [artifactDescription(artifact), artifactMeta(artifact)]
    .filter(Boolean)
    .join(" / ");

  return (
    <Stack gap="md">
      <PanelHeader
        actions={
          <Button
            iconStart={<ArrowLeft size={14} />}
            size="xs"
            text={appCopy.artifacts.backToList}
            variant="borderless"
            onClick={onBack}
          />
        }
        description={meta}
        title={artifact.title}
      />
      <ArtifactPreview data-test-class="artifact-viewer">
        {renderPreview({ mode, state, text, title: artifact.title, url })}
      </ArtifactPreview>
    </Stack>
  );
}

function renderPreview(input: {
  mode: ReturnType<typeof artifactPreviewMode>;
  state: "idle" | "loading" | "failed";
  text: string;
  title: string;
  url?: string;
}) {
  if (!input.url || input.mode === "unsupported") {
    return <Typo.Caption>{appCopy.artifacts.unsupported}</Typo.Caption>;
  }
  if (input.mode === "image") {
    return <ArtifactPreviewImage alt={input.title} src={input.url} />;
  }
  if (input.mode === "pdf") {
    return <ArtifactPreviewFrame src={input.url} title={input.title} />;
  }
  if (input.state === "loading") {
    return <Typo.Caption>{appCopy.artifacts.loading}</Typo.Caption>;
  }
  if (input.state === "failed") {
    return <Typo.Caption>{appCopy.artifacts.loadFailed}</Typo.Caption>;
  }
  if (input.mode === "markdown") {
    return (
      <MarkdownContent>
        <ReactMarkdown
          components={MARKDOWN_COMPONENTS}
          remarkPlugins={[remarkGfm]}
        >
          {input.text}
        </ReactMarkdown>
      </MarkdownContent>
    );
  }
  return <ArtifactPreviewPre>{input.text}</ArtifactPreviewPre>;
}
