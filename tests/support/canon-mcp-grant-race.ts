// test-category: race
import type { Page } from "playwright";

/** A fresh request/decision can precede the previous revoke's HTTP response. */
export async function delayCanonGrantRevoke(page: Page, id: string) {
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  await page.route(`**/canon/mcp-grants/${id}/revoke`, async route => {
    const response = await route.fetch();
    await release.promise;
    try { await route.fulfill({ response }); }
    finally { delivered.resolve(); }
  });
  return { release: () => release.resolve(), settled: delivered.promise };
}
