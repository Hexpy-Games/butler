/** Which scanned targets a saved card or traveler profile fills, and the text
 * each one gets. Values pass through main only for the duration of one fill. */

const CARD = { number: "number", expiry: "expiry", exp_month: "exp_month", exp_year: "exp_year", cvc: "cvc", name: "name", pin_short: "pin2", birth: "owner_id" };
const TRAVELER = { full_name: "full_name", surname: "surname", given_name: "given_name", birth: "birth_date", gender: "gender",
  nationality: "nationality", passport_number: "passport_number", passport_expiry: "passport_expiry", rrn: "rrn", phone: "phone", email: "email" };
/** Kinds whose value may be split across consecutive short fields. */
const SPLIT = new Set(["number", "rrn", "phone"]);

/** The vault field a target takes in this fill, if any. */
export function fieldOf(kind, target) {
  if (kind === "card") return target.card || target.kind === "number" || target.kind === "cvc" ? CARD[target.kind] ?? null : null;
  return target.card && ["birth", "full_name", "phone", "email"].includes(target.kind) ? null : TRAVELER[target.kind] ?? null;
}

/** Steps in document order: the first target of each field, plus split groups. */
export function plan(kind, frames) {
  const steps = [], seen = new Set();
  for (const frame of frames) {
    let group = null;
    for (const target of frame.targets) {
      const field = fieldOf(kind, target);
      if (!field) { group = null; continue; }
      const split = SPLIT.has(field) && target.max > 0 && target.max <= 7;
      if (split && group?.field === field && group.frame === frame) { group.parts.push(target); continue; }
      if (seen.has(field) && !(field === "gender" && target.tag === "radio")) { group = null; continue; }
      if (field === "gender" && target.tag === "radio") {
        const radios = steps.find(step => step.field === "gender" && step.frame === frame && step.radios);
        if (radios) { radios.radios.push(target); continue; }
        if (seen.has(field)) continue;
        seen.add(field); steps.push({ frame, field, target, radios: [target] }); continue;
      }
      seen.add(field);
      const step = { frame, field, target, parts: [target] };
      steps.push(step);
      group = split ? step : null;
    }
  }
  return steps;
}

const pad = value => String(value).padStart(2, "0");

/** A date as the field asks for it: `YYYY-MM-DD` input from the vault. */
function dateText(iso, target) {
  const [year, month, day] = String(iso).split("-");
  if (!day) return null;
  if (target.type === "date") return `${year}-${month}-${day}`;
  const dotted = /\./u.test(target.placeholder ?? "") ? "." : /-/u.test(target.placeholder ?? "") ? "-" : /\//u.test(target.placeholder ?? "") ? "/" : "";
  if (target.max === 6) return `${year.slice(2)}${month}${day}`;
  if (target.max === 8 || !dotted && target.max !== 10) return `${year}${month}${day}`;
  return [year, month, day].join(dotted || "-");
}

function optionFor(target, matches) {
  return target.options?.find(([value, label]) => matches(value) || matches(label))?.[0] ?? null;
}

const GENDER = { M: /^(m|male|man|남|남자|남성)$/iu, F: /^(f|female|woman|여|여자|여성)$/iu };
const COUNTRY = { KR: /^(kr|kor|korea|south korea|republic of korea|대한민국|한국)$/iu };

/** The texts for one step (one per part), or `null` when the vault lacks it. */
export function texts(step, values, meta) {
  const { field, target } = step;
  const details = meta?.details ?? {};
  switch (field) {
    case "number": case "rrn": case "phone": {
      const raw = field === "phone" ? String(details.phone ?? "").replace(/[^0-9+]/gu, "") : values[field];
      if (!raw) return null;
      if (step.parts.length === 1) return [field === "rrn" && target.max === 14 ? `${raw.slice(0, 6)}-${raw.slice(6)}` : raw];
      let offset = 0;
      return step.parts.map((part, index) => {
        const size = index === step.parts.length - 1 ? raw.length - offset : part.max;
        const chunk = raw.slice(offset, offset + size); offset += size; return chunk;
      });
    }
    case "expiry": {
      const month = pad(meta.exp_month), year = String(meta.exp_year);
      if (/yyyy/iu.test(target.placeholder) || target.max === 7) return [`${month}/${year}`];
      if (target.max === 4 || /mmyy/iu.test(target.placeholder)) return [`${month}${year.slice(2)}`];
      return [`${month}/${year.slice(2)}`];
    }
    case "exp_month": return [target.tag === "select" ? optionFor(target, v => Number(v) === Number(meta.exp_month) && /^\s*\d{1,2}\s*(월)?\s*$/u.test(v)) : pad(meta.exp_month)];
    case "exp_year": {
      const year = Number(meta.exp_year);
      if (target.tag === "select") return [optionFor(target, v => /^\s*\d{2,4}\s*(년)?\s*$/u.test(v) && (Number(v) === year || Number(v) === year % 100))];
      return [target.max === 2 ? String(year).slice(2) : String(year)];
    }
    case "name": return meta.holder_name ? [meta.holder_name] : null;
    case "cvc": case "pin2": case "owner_id": case "passport_number": return values[field] ? [values[field]] : null;
    case "birth_date": return values.birth_date ? [dateText(values.birth_date, target)] : null;
    case "passport_expiry": return details.passport_expiry ? [dateText(details.passport_expiry, target)] : null;
    case "full_name": case "surname": case "given_name": case "email": {
      const key = { full_name: "name", surname: "name_latin_surname", given_name: "name_latin_given", email: "email" }[field];
      return details[key] ? [details[key]] : null;
    }
    case "gender": {
      const pattern = GENDER[details.gender];
      if (!pattern) return null;
      if (step.radios) { const radio = step.radios.find(item => item.value.split(/\s+/u).some(word => pattern.test(word))); return radio ? [radio] : null; }
      return [optionFor(target, v => pattern.test(String(v).trim()))];
    }
    case "nationality": {
      const code = details.nationality;
      if (!code) return null;
      if (target.tag !== "select") return [code];
      return [optionFor(target, v => String(v).trim().toUpperCase() === code || (COUNTRY[code]?.test(String(v).trim()) ?? false))];
    }
    default: return null;
  }
}
