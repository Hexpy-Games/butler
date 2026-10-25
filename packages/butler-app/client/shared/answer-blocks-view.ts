import type { AnswerLeafBlock, CardItem, CardsBlock, GalleryBlock, ImageBlock } from "./app-contracts";

/** Signed gateway decoration remains outside the model-facing contract. */
export type AnswerCardView = CardItem & { image_url?: string };
export type AnswerCardsView = Omit<CardsBlock, "items"> & { items: AnswerCardView[] };
export type AnswerGalleryView = Omit<GalleryBlock, "items"> & {
  items: (GalleryBlock["items"][number] & { image_url?: string })[];
};
export type AnswerImageView = ImageBlock & { image_url?: string; image_width?: number; image_height?: number };
export type AnswerLeafView = Exclude<AnswerLeafBlock, CardsBlock | GalleryBlock | ImageBlock> | AnswerCardsView | AnswerGalleryView | AnswerImageView;
export type AnswerContainerView = { type: "columns" | "group"; id?: string; title?: string; blocks: AnswerLeafView[] }
  | { type: "tabs"; id?: string; title?: string; tabs: { label: string; blocks: AnswerLeafView[] }[] };
export type AnswerBlockView = AnswerLeafView | AnswerContainerView;
export type AnswerBlocksView = { v: 1 | 2; blocks: AnswerBlockView[] };
