/** Generic local forms. Posted values are compared here; only verdicts persist. */
export const PROFILE = { nickname: "Self", name: "Sample Person", family_name: "Person", given_name: "Sample",
  name_latin: "Sample Person", name_latin_surname: "Person", name_latin_given: "Sample", email: "self@example.test", phone: "+821012345678",
  organization: "Example", country: "KR", postal_code: "12345", region: "Seoul", city: "Seoul", address_line1: "12 Sample Street", address_line2: "Unit 2",
  birth_date: "1990-01-01", gender: "M", passport_number: "P98765432", passport_expiry: "2030-12-31", nationality: "KR", issuing_country: "KR" };
export const SIGNUP_FIELDS = ["full_name", "family_name", "given_name", "name_latin", "name_latin_surname", "name_latin_given", "email", "phone", "organization", "country", "postal_code", "region", "city", "address_line1", "address_line2"];
export const ID_LABELS: Record<string, string> = { birth_date: "出生日期", passport_number: "여권 번호" };
export const ID_FIELDS = ["birth_date", "passport_number", "passport_expiry", "nationality", "issuing_country"];
export function autofillFixture(request: Request, path: string, verdicts: string[]): Response | Promise<Response> | undefined {
  const fields = path.startsWith("/signup") ? SIGNUP_FIELDS : path.startsWith("/identity") ? ID_FIELDS : null;
  if (!fields) return;
  if (request.method === "POST") return request.text().then(text => {
    const form = new URLSearchParams(text);
    const matches = fields.every(field => form.get(field === "passport_number" ? "document" : field) === PROFILE[(field === "full_name" ? "name" : field) as keyof typeof PROFILE]);
    verdicts.push(`${path}:${matches ? "ok" : "mismatch"}`);
    return new Response("Complete");
  });
  return new Response(`<!doctype html><meta charset="utf-8"><title>Profile form</title>
    <style>body{font:16px system-ui;padding:24px}form{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}input{display:block;width:220px;margin:4px 0}</style>
    <form method="post" action="${path}/submit">${fields.map(field => `<label id="label-${field}">${ID_LABELS[field] ?? field}<input name="${field === "passport_number" ? "document" : field}" aria-labelledby="label-${field}" ${field === "birth_date" ? 'autocomplete="section-person bday"' : ""} ${["birth_date", "passport_expiry"].includes(field) ? 'type="date"' : ""}></label>`).join("")}<button>Save</button></form>`,
  { headers: { "content-type": "text/html; charset=utf-8" } });
}
