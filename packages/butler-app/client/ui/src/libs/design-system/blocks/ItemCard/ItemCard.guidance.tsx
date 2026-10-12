import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { CopyButton } from "../../components/CopyButton";
import { Grid } from "../../components/Grid";
import { IconButton } from "../../components/IconButton";
import { Scrap } from "../../components/Icons";
import { MediaFrame } from "../../components/MediaFrame";
import { fixturePicture } from "../../components/MediaFrame/fixtures";
import { Typo } from "../../components/Typo";
import { ItemCard } from "./ItemCard";

// #region recipe: Cards of found items
function FoundItems() {
  const actions = (title: string) => (
    <>
      <IconButton label="Save to library"><Scrap size="sm" /></IconButton>
      <CopyButton label="Copy" copiedLabel="Copied" text={title} />
    </>
  );
  return (
    <Grid columns={{ base: "2", compact: "1" }} gap="md">
      <ItemCard eyebrow="1 · Closest match" subtitle="Kim, Ortega, Liu · ACL 2026" title="Sparse retrieval for long multilingual documents"
        media={<MediaFrame aspect="4:5" src={fixturePicture("paper")} />} value={{ amount: "1,284 citations", note: "Open-access PDF" }}
        facts={["32 pages", "Code released"]} actions={actions("Sparse retrieval")} onOpen={() => undefined}
        source={{ site: "papers.example.org", checked: "Checked 5:41 PM", label: "papers.example.org, checked at 5:41 PM, open the page", onOpen: () => undefined }} />
      <ItemCard eyebrow="2 · Easy half day" subtitle="Trail · Lake district" title="Lakeside loop trail"
        media={<MediaFrame aspect="4:5" src={fixturePicture("place")} />} value={{ amount: "4.6 km", note: "Loop · about 1 h 40 min" }}
        facts={["Flat", "Dogs allowed"]} actions={actions("Lakeside loop trail")} onOpen={() => undefined}
        source={{ site: "trails.example.org", checked: "Checked 5:41 PM", label: "trails.example.org, checked at 5:41 PM, open the page", onOpen: () => undefined }} />
    </Grid>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One found item of any subject (a paper, a place, a recipe, a product, a library) with its picture, a value, facts, a reason and the page it was read from.",
  whenToUse: ["Answer cards: items the user compares or chooses between", "Any set of results that each have a source page and a key value"],
  whenNotToUse: [
    { when: "A saved library (서랍) item", use: "LibraryCard" },
    { when: "One number with a trend", use: "MetricCard" },
    { when: "Many attributes compared side by side", use: "MarkdownContent" },
  ],
  recipes: [{ name: "Cards of found items", description: "One aspect per set; the container formats values and owns save, copy and open.", render: () => <FoundItems /> }],
  doDont: [
    {
      do: { caption: "Pass the value formatted, with its unit or currency.", render: () => <ItemCard title="Lakeside loop trail" value={{ amount: "4.6 km", note: "Loop" }} /> },
      dont: { caption: "Do not build a card for one subject (a price card, a paper card).", render: () => <Card><Typo.Text>$39.00 · Add to cart</Typo.Text></Card> },
    },
  ],
  content: [
    "Every prop is neutral: value is a price, a distance, a duration, a rating or a count. Format it in the container (“76,390원”, “4.6 km”, “25 min”).",
    "Eyebrow: a rank and a short reason, about 24 characters. Subtitle: author, venue, area or maker. Facts: up to four short items.",
    "Text: plain, one or two sentences about why this item; never repeat the title or the value.",
    "Source: the site and the time it was read (“오후 5:41 확인” / “Checked 5:41 PM”); never call a stored value current.",
  ],
  accessibility: [
    "The card is an article labelled by its title. The title is one button; the picture opens the same item but is out of the tab order.",
    "The source line is a button named by source.label (site and read time). Actions are labelled IconButtons.",
    "wasLabel is read before the struck-through amount. Show more carries aria-expanded and aria-controls.",
  ],
  tokens: ["--surface-raised", "--line", "--text-secondary", "--text-tertiary", "--space-sm", "--space-md", "--line-height-body"],
};
