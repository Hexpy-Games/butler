// Showcase sets: unrelated pictures with captions and sources, in both locales.
import { BROKEN_PICTURE, fixturePicture } from "../../components/MediaFrame/fixtures";
import type { ImageViewerImage, ImageViewerLabels } from "./ImageViewerSurface";

type Locale = "en-US" | "ko-KR";

export const VIEWER_LABELS: Record<Locale, ImageViewerLabels & { open: string; save: string; saved: string; copy: string; view: string }> = {
  "en-US": {
    close: "Close", previous: "Previous image", next: "Next image", position: (current, total) => `${current} / ${total}`,
    failed: "The image could not load", zoomIn: "Zoom in", zoomOut: "Zoom out", open: "Open the source page", save: "Save to library", saved: "Saved to library", copy: "Copy image", view: "View",
  },
  "ko-KR": {
    close: "닫기", previous: "이전 이미지", next: "다음 이미지", position: (current, total) => `${current} / ${total}`,
    failed: "이미지를 불러오지 못했습니다", zoomIn: "확대", zoomOut: "축소", open: "원본 페이지 열기", save: "서랍에 저장", saved: "서랍에 저장했어요", copy: "이미지 복사", view: "보기",
  },
};

export function viewerImages(locale: Locale): ImageViewerImage[] {
  const ko = locale === "ko-KR";
  return [
    { src: fixturePicture("product"), alt: ko ? "구스넥 주전자" : "Gooseneck kettle",
      caption: ko ? "구스넥 드립 주전자 · 매트 블랙" : "Gooseneck pour-over kettle · matte black",
      source: { site: "shop.example.com", checked: ko ? "오후 5:41 확인" : "Checked 5:41 PM" } },
    { src: fixturePicture("place"), alt: ko ? "호숫가 산책로" : "Lakeside trail",
      caption: ko ? "호숫가 순환 산책로, 동쪽 기슭" : "Lakeside loop trail, east shore",
      source: { site: "trails.example.org", checked: ko ? "10/12 확인" : "Checked 10/12" } },
    { src: fixturePicture("recipe"), alt: ko ? "김치볶음밥" : "Kimchi fried rice" },
  ];
}

export const BROKEN_IMAGE: ImageViewerImage = { src: BROKEN_PICTURE, alt: "Broken" };
