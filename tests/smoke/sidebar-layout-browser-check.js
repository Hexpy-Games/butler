// Run in an open product sidebar with >1 viewport of sessions:
// agent-browser --session <name> eval --stdin < tests/smoke/sidebar-layout-browser-check.js
(async () => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const sidebar = document.querySelector('[aria-label="스페이스 탐색"]');
  assert(getComputedStyle(sidebar).visibility !== "hidden" && getComputedStyle(sidebar.querySelector("[data-test-class=sidebar-scroll]")).visibility !== "hidden", "Open the sidebar before checking its layout");
  const scroll = sidebar.querySelector('[data-test-class="sidebar-scroll"]');
  const header = sidebar.querySelector('[data-test-class="sidebar-sticky-header"]');
  const actions = sidebar.querySelector('[aria-label="대화 시작과 검색"]');
  scroll.scrollTop = 0;
  await frame();
  const actionRows = [...actions.children].map(el => el.getBoundingClientRect());
  assert(actionRows[1].top >= actionRows[0].bottom, "Primary actions must be separate vertical rows");
  assert(Math.abs(actionRows[0].width - actionRows[1].width) < 1, "Primary actions need equal full width");
  assert(getComputedStyle(scroll).maskImage !== "none", "Scroll fade must remain enabled");
  const empty = [...sidebar.querySelectorAll("span")].find(el => el.textContent === "자주 찾는 대화를 고정해 보세요.");
  if (empty) {
    const text = document.createRange();
    text.selectNodeContents(empty);
    const icon = actions.querySelector("svg").getBoundingClientRect();
    assert(Math.abs(text.getBoundingClientRect().left - icon.left) < 1, "Empty favorites text must align with row icons");
    assert(parseFloat(getComputedStyle(empty.parentElement.parentElement).gap) === 8, "Favorites heading needs 8px separation");
  }
  const initialHeaderTop = header.getBoundingClientRect().top;
  const initialActionsTop = actions.getBoundingClientRect().top;
  assert(scroll.scrollHeight > scroll.clientHeight + initialHeaderTop, "Fixture needs enough scrollable rows");
  scroll.scrollTop = 80;
  await frame();
  assert(Math.abs(initialHeaderTop - header.getBoundingClientRect().top - 80) < 1, "Browse header must initially scroll with the menu");
  assert(Math.abs(initialActionsTop - actions.getBoundingClientRect().top - 80) < 1, "Entry actions must scroll, not remain fixed");
  scroll.scrollTop = initialHeaderTop + 100;
  await frame();
  const pinnedTop = header.getBoundingClientRect().top;
  const expectedTop = scroll.getBoundingClientRect().top + parseFloat(getComputedStyle(sidebar).getPropertyValue("--sidebar-scroll-fade-size"));
  assert(Math.abs(pinnedTop - expectedTop) < 1, "Browse header must stick below the fade");
  const firstRow = sidebar.querySelector('[aria-label="대화 목록"]').querySelector('[role="button"]');
  const firstTop = firstRow.getBoundingClientRect().top;
  scroll.scrollTop += 100;
  await frame();
  assert(Math.abs(header.getBoundingClientRect().top - pinnedTop) < 1, "Sticky header must remain pinned");
  assert(Math.abs(firstRow.getBoundingClientRect().top - firstTop + 100) < 1, "Rows must continue scrolling under the pinned header");
  return { passed: true, width: innerWidth, initialHeaderTop, pinnedTop, scrollTop: scroll.scrollTop, fade: getComputedStyle(scroll).maskImage };
})();
