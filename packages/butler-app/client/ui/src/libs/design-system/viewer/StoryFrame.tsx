import { Component, type ReactNode } from "react";
import { Notice } from "../blocks/Notice";
import type { ShowcaseStory, ShowcaseWidth } from "../showcase/types";
import type { ResolvedTheme } from "./useViewerTheme";
import type { ViewerLocale } from "./viewerState";
import styles from "./DesignSystemViewer.module.css";

class StoryErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return <Notice tone="error" title="Story failed to render" message={this.state.error.message} />;
  }
}

function StoryRender({ story, locale }: { story: ShowcaseStory; locale: ViewerLocale }) {
  return <>{story.render({ locale: locale === "ko" ? "ko-KR" : "en-US" })}</>;
}

/** Story canvas; hooks inside `story.render` belong to StoryRender. */
export function StoryCanvas({ story, locale }: { story: ShowcaseStory; locale: ViewerLocale }) {
  return (
    <div className={styles.preview}>
      <div className={styles.canvas} data-ds-fixture-canvas lang={locale}>
        <StoryErrorBoundary>
          <StoryRender story={story} locale={locale} />
        </StoryErrorBoundary>
      </div>
    </div>
  );
}

export function StoryFrames({
  story,
  locale,
  themes,
  width,
}: {
  story: ShowcaseStory;
  locale: ViewerLocale;
  themes: ResolvedTheme[];
  width: ShowcaseWidth;
}) {
  return (
    <div className={styles.frames} data-count={themes.length}>
      {themes.map((theme) => (
        <div className={`${styles.frame} theme-${theme}`} data-ds-theme={theme} key={theme}>
          <div className={styles[`width-${width}`]}>
            <StoryCanvas story={story} locale={locale} />
          </div>
        </div>
      ))}
    </div>
  );
}
