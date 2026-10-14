import type { AnswerBlock, CardItem, CardsBlock, GalleryBlock } from "./app-contracts";

/** Gateway capability metadata never becomes part of the model-facing spec. */
export type AnswerCardView = CardItem & { image_url?: string };
export type AnswerCardsView = Omit<CardsBlock, "items"> & { items: AnswerCardView[] };
export type AnswerGalleryView = Omit<GalleryBlock, "items"> & {
  items: (GalleryBlock["items"][number] & { image_url?: string })[];
};
export type AnswerBlockView = Exclude<AnswerBlock, CardsBlock | GalleryBlock> | AnswerCardsView | AnswerGalleryView;
export type AnswerBlocksView = { v: 1; blocks: AnswerBlockView[] };
