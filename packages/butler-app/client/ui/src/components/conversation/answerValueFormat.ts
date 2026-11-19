import type { AppLocale } from "@/app/copy";
import type { CardValue } from "../../../../shared/app-contracts";

/** Currencies a language names with its own unit word after the number ("76,390원", "1,200엔"). */
const CURRENCY_WORDS: Partial<Record<AppLocale, Readonly<Record<string, string>>>> = {
  "ko-KR": { KRW: "원", JPY: "엔", CNY: "위안" },
};

/** Other currencies keep Intl's form; Korean UIs write them with the bare symbol ("$12.50", not "US$12.50"). */
const CURRENCY_DISPLAY: Partial<Record<AppLocale, Intl.NumberFormatOptions["currencyDisplay"]>> = {
  "ko-KR": "narrowSymbol",
};

/** One card value (or its `was`) in the App language: the currency's native word when it has one, else Intl. */
export function formatAnswerValue(value: CardValue, locale: AppLocale, amount = value.amount): string {
  if (!value.cur) return [new Intl.NumberFormat(locale).format(amount), value.unit].filter(Boolean).join(" ");
  const currency = value.cur.toUpperCase();
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: CURRENCY_DISPLAY[locale] });
  } catch {
    return `${new Intl.NumberFormat(locale).format(amount)} ${value.cur}`;
  }
  const word = CURRENCY_WORDS[locale]?.[currency];
  if (!word) return format.format(amount);
  // The currency's own fraction digits and sign, without its symbol and the space around it.
  const number = format.formatToParts(amount).filter(part => part.type !== "currency" && part.type !== "literal");
  return `${number.map(part => part.value).join("")}${word}`;
}
