import type { Page } from "playwright";

/** Scripted gold path validates fixture server predicates, not a model arm. */
export async function completeFixture(page: Page, id: string) {
  switch (id) {
    case "F01": case "F03": case "F16": case "F17": case "F19": case "F20":
      await page.locator("#real").click(); break;
    case "F02":
      await page.locator("#real").focus(); await page.keyboard.press("Enter"); break;
    case "F04": {
      const download = page.waitForEvent("download");
      await page.locator("#download").click(); await download; break;
    }
    case "F05":
      await page.locator("#dismiss").click(); await page.locator("#reject").click(); await page.locator("#task").click(); break;
    case "F06": await page.locator("#correct").click(); break;
    case "F07":
      await page.locator("#open-target").click();
      // Closed root requires a real point dispatch, not page-JS access.
      await page.locator("#closed-host").click(); break;
    case "F08":
      await page.frameLocator("iframe[title=same-site]").locator("#same-name").fill("버틀러");
      await page.frameLocator("iframe[title=same-site]").locator("#same-submit").click(); break;
    case "F09": {
      await page.locator("#keyboard-grid").focus();
      for (const key of ["ArrowRight", "ArrowDown", "ArrowDown"]) await page.keyboard.press(key);
      await page.keyboard.type("value"); await page.keyboard.press("Enter");
      await page.locator("#mouse-grid").click({ position: { x: 135, y: 100 } });
      await page.locator("#mouse-grid").click({ position: { x: 35, y: 210 } }); break;
    }
    case "F10":
      await page.locator("#list").evaluate((el) => { el.scrollTop = 737 * 30; });
      await page.locator("#item-737").click(); break;
    case "F11": await page.locator("#edit-12").click(); break;
    case "F12": await page.locator("#date-23").click(); break;
    case "F13": await page.locator("#cart").click(); break;
    case "F14": {
      await page.locator("#name").fill("홍길동"); await page.locator("#digits").fill("１２３４");
      const popup = page.waitForEvent("popup"); await page.locator("#postcode").click();
      const address = await popup; await address.locator("#choose").click();
      await page.locator("#address").waitFor();
      await page.waitForFunction("document.querySelector('#address').value === '서울 중구 세종대로 110'");
      await page.locator("#submit").click(); break;
    }
    case "F15": await page.locator("#addon").uncheck(); await page.locator("#checkout").click(); break;
    case "F18":
      await page.locator("#slider").focus(); await page.keyboard.press("Home");
      for (let n = 0; n < 75; n++) await page.keyboard.press("ArrowRight");
      await page.locator("#a").dragTo(page.locator("#b")); break;
    default: throw new Error(`Missing gold path ${id}`);
  }
}
