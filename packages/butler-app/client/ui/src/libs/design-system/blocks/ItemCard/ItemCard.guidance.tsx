import { useEffect, useRef, useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { CopyButton } from "../../components/CopyButton";
import { Grid } from "../../components/Grid";
import { IconButton } from "../../components/IconButton";
import { Scrap } from "../../components/Icons";
import { MediaFrame } from "../../components/MediaFrame";
import { fixturePicture } from "../../components/MediaFrame/fixtures";
import { Typo } from "../../components/Typo";
import { settleGrid } from "../../lib/gridSettle";
import { ItemCard } from "./ItemCard";
import { ItemCardSkeleton } from "./ItemCardSkeleton";

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

// #region recipe: Cards that stream in
function StreamingCards({ titles, open }: { titles: string[]; open: boolean }) {
  const grid = useRef<HTMLElement>(null);
  const [settled, setSettled] = useState(false);
  const live = titles.length >= 4 ? "4" : "2"; // from the grid's width while the list is open
  const final = titles.length === 5 ? "3" : live; // the lone-card rule, once at close
  useEffect(() => {
    if (!open && !settled && grid.current) settleGrid(grid.current, () => setSettled(true), { reflow: final !== live });
  }, [open, settled, final, live]);
  return (
    <Grid ref={grid} columns={settled ? final : live} cross={settled ? "stretch" : "start"} gap="sm">
      {titles.map((title) => <ItemCard key={title} title={title} media={<MediaFrame aspect="1:1" fit="cover" placeholder />} />)}
      {open ? <ItemCardSkeleton media="1:1" /> : null}
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
  recipes: [
    { name: "Cards of found items", description: "One aspect per set; the container formats values and owns save, copy and open.", render: () => <FoundItems /> },
    {
      name: "Cards that stream in",
      description: "While the list is open, cells keep their own height and one ItemCardSkeleton holds the next slot; at close settleGrid applies the final columns once.",
      render: () => <StreamingCards titles={["Lakeside loop trail", "Kimchi fried rice"]} open />,
    },
  ],
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
    "Loading: ItemCardSkeleton in the set's media aspect holds the next slot. It is the exact box of a card with a subtitle, a one-line title, facts and a footer, so swapping it for that card shifts nothing.",
  ],
  accessibility: [
    "The card is an article labelled by its title. The title is its one button and its target covers the whole card, so a click anywhere opens the item.",
    "With onMediaOpen the picture is its own button (named by mediaLabel) that opens the image viewer; without it the picture is part of the card target.",
    "The source line, Show more and the actions keep their own actions; the card's hover drops while the pointer is on one of them.",
    "The source line is a button named by source.label (site and read time). Actions are labelled IconButtons.",
    "wasLabel is read before the struck-through amount. Show more carries aria-expanded and aria-controls.",
    "ItemCardSkeleton is aria-hidden unless it gets a label; label one skeleton (role status) so loading is announced once.",
  ],
  tokens: ["--surface-raised", "--line", "--text-secondary", "--text-tertiary", "--space-sm", "--space-md", "--line-height-body"],
};
