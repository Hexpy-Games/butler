import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GitDependencyNoticePresenter } from "./GitDependencyNoticePresenter";

test("Git dependency notice explains non-blocking degradation and links installation", () => {
  const html = renderToStaticMarkup(
    <GitDependencyNoticePresenter
      actionLabel="Git 설치 안내"
      closeLabel="Git 안내 닫기"
      message="Butler는 계속 사용할 수 있지만 Git 기반 기능은 사용할 수 없습니다."
      onDismiss={() => undefined}
      title="Git이 설치되어 있지 않습니다"
    />,
  );

  expect(html).toContain("Git이 설치되어 있지 않습니다");
  expect(html).toContain("Butler는 계속 사용할 수 있지만");
  expect(html).toContain("https://git-scm.com/downloads");
  expect(html).toContain('target="_blank"');
  expect(html).toContain('aria-label="Git 안내 닫기"');
});
