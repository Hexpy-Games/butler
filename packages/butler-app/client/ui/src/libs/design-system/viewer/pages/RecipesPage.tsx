import screensSource from "../recipes/screens.tsx?raw";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { recipeSource } from "../../showcase/collectShowcaseEntries";
import type { ShowcaseRenderContext } from "../../showcase";
import { CodeSample, PageHeader } from "../parts";
import { RECIPES } from "../recipes";
import styles from "../DesignSystemViewer.module.css";

type AppLocale = ShowcaseRenderContext["locale"];

/** Build a screen: real Butler screens from DS pieces only, with their exact JSX. */
export function RecipesPage({ locale }: { locale: AppLocale }) {
  return (
    <Stack gap="2xl" data-ds-recipes={RECIPES.length}>
      <PageHeader eyebrow="Build a screen" title="Screens, assembled from the system"
        lead="Each recipe is a real Butler screen composed only of DS components and blocks: no CSS files and no className. The one inline style sizes Skeleton, which has no size props yet. The code under each screen is the exact JSX that renders it." />
      {RECIPES.map(({ id, title, description, uses, Screen }) => (
        <Section id={`recipe-${id}`} key={id} title={title} titleAs="h2" description={description} data-ds-recipe={id}>
          <Stack align="row" gap="xs" wrap>{uses.map((name) => <Tag key={name}>{name}</Tag>)}</Stack>
          <div className={styles.recipeFrame} lang={locale === "ko-KR" ? "ko" : "en"}><Screen /></div>
          <CodeSample code={recipeSource(screensSource, title) ?? ""} />
        </Section>
      ))}
    </Stack>
  );
}
