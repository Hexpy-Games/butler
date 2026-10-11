// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { splitTextMatches } from "../../lib/textMatch";
import { AddressField } from "../AddressField";
import { HistoryGroup, HistoryRow } from "../HistoryRow";
import { SuggestionList, SuggestionRow } from "./SuggestionList";

function render(node: React.ReactElement) {
  return new JSDOM(renderToStaticMarkup(node)).window.document;
}

test("query terms split text into merged, case-insensitive match runs", () => {
  expect(splitTextMatches("History Alpha", "hist")).toEqual([{ text: "Hist", match: true }, { text: "ory Alpha", match: false }]);
  expect(splitTextMatches("docs.example.com/docs", "docs ex")).toEqual([
    { text: "docs", match: true }, { text: ".", match: false }, { text: "ex", match: true }, { text: "ample.com/", match: false }, { text: "docs", match: true },
  ]);
  expect(splitTextMatches("aaa", "aa")).toEqual([{ text: "aaa", match: true }]);
  expect(splitTextMatches("방문 기록", "기록")).toEqual([{ text: "방문 ", match: false }, { text: "기록", match: true }]);
  expect(splitTextMatches("Title", "  ")).toEqual([{ text: "Title", match: false }]);
  expect(splitTextMatches("", "x")).toEqual([]);
});

test("suggestion rows are listbox options with the address, bold matches and a named bookmark star", () => {
  const document = render(
    <SuggestionList id="address-suggestions" label="Address suggestions">
      <SuggestionRow id="s-0" title="History Alpha" url="http://127.0.0.1:57817/" query="history" active kind="bookmark" bookmarkLabel="Bookmarked" onSelect={() => undefined} />
      <SuggestionRow id="s-1" url="https://example.com/docs/" query="docs" onSelect={() => undefined} />
    </SuggestionList>,
  );
  const list = document.querySelector("[role=listbox]")!;
  expect(list.id).toBe("address-suggestions");
  expect(list.getAttribute("aria-label")).toBe("Address suggestions");
  const [first, second] = [...document.querySelectorAll("[role=option]")];
  expect(first!.id).toBe("s-0");
  expect(first!.getAttribute("aria-selected")).toBe("true");
  expect(second!.getAttribute("aria-selected")).toBe("false");
  expect(first!.querySelector("mark")!.textContent).toBe("History");
  expect(first!.textContent).toContain("127.0.0.1:57817");
  expect(first!.textContent).not.toContain("http://");
  expect(first!.querySelector("[role=img]")!.getAttribute("aria-label")).toBe("Bookmarked");
  expect(second!.textContent).toBe("example.com/docs/");
  expect(second!.querySelector("mark")!.textContent).toBe("docs");
  expect(second!.querySelector("[role=img]")).toBeNull();
  const untitled = render(<SuggestionRow id="u" title="https://example.com/x" url="https://example.com/x" onSelect={() => undefined} />);
  expect(untitled.querySelector("[role=option]")!.textContent).toBe("example.com/x");
});

test("the editing address field is a combobox that points at the highlighted suggestion", () => {
  const document = render(
    <AddressField url="https://example.com/" editing onSubmit={() => undefined} onInputChange={() => undefined}
      listbox={{ id: "address-suggestions", expanded: true, activeOptionId: "s-1" }} />,
  );
  const input = document.querySelector("input")!;
  expect(input.getAttribute("role")).toBe("combobox");
  expect(input.getAttribute("aria-autocomplete")).toBe("list");
  expect(input.getAttribute("aria-controls")).toBe("address-suggestions");
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(input.getAttribute("aria-activedescendant")).toBe("s-1");
  const closed = render(<AddressField url="https://example.com/" editing onSubmit={() => undefined} listbox={{ id: "l", expanded: false, activeOptionId: "s-1" }} />);
  expect(closed.querySelector("input")!.getAttribute("aria-expanded")).toBe("false");
  expect(closed.querySelector("input")!.hasAttribute("aria-activedescendant")).toBe(false);
  const plain = render(<AddressField url="https://example.com/" editing onSubmit={() => undefined} />);
  expect(plain.querySelector("input")!.hasAttribute("role")).toBe(false);
});

test("history rows open as buttons, become checkboxes only in selection mode, and keep the time", () => {
  const actions = <button type="button" aria-label="Delete: Alpha">x</button>;
  const browse = render(
    <HistoryGroup title="Today">
      <HistoryRow rowId={7} title="Alpha" url="https://alpha.example.com/a?b=1" time="8:27 PM" dateTime="2026-10-11T20:27:00Z" onOpen={() => undefined} actions={actions} />
    </HistoryGroup>,
  );
  expect(browse.querySelector("section")!.getAttribute("aria-label")).toBe("Today");
  const row = browse.querySelector("[data-row-id=\"7\"]")!;
  const main = row.querySelector("[role=button]")!;
  expect(main.getAttribute("aria-label")).toBe("Alpha, alpha.example.com");
  expect(row.querySelector("time")!.getAttribute("datetime")).toBe("2026-10-11T20:27:00Z");
  expect(row.querySelector("time")!.textContent).toBe("8:27 PM");
  expect(row.querySelector("[aria-label=\"Delete: Alpha\"]")).not.toBeNull();
  expect(row.querySelector("[role=checkbox]")).toBeNull();

  const select = render(<HistoryRow title="" url="https://beta.example.com/" time="9:00 AM" onOpen={() => undefined} actions={actions} selecting selected />);
  const box = select.querySelector("[role=checkbox]")!;
  expect(box.getAttribute("aria-checked")).toBe("true");
  expect(box.getAttribute("aria-label")).toBe("beta.example.com");
  expect(select.querySelector("[aria-label=\"Delete: Alpha\"]")).toBeNull();
  expect(select.querySelector("time")!.textContent).toBe("9:00 AM");

  const untitled = render(<HistoryRow title="http://127.0.0.1:5/a" url="http://127.0.0.1:5/a" time="9:01 AM" onOpen={() => undefined} />);
  expect(untitled.querySelector("[role=button]")!.getAttribute("aria-label")).toBe("127.0.0.1:5/a, 127.0.0.1:5");
  expect(untitled.querySelector("[role=button]")!.textContent).toBe("127.0.0.1:5/a");
});
