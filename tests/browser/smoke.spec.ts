// Smoke test in a real browser: the landing page in both languages, the
// status of the docs and Discord, no CSP violations, no cookies; the public
// status endpoint with its CORS header.
import { expect, test, type Page } from "@playwright/test";

function watchCsp(page: Page) {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  return violations;
}

test("the landing page says what Flo is, shows the status and switches the language", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-GB" });
  const page = await context.newPage();
  const csp = watchCsp(page);
  const response = await page.goto("/");
  expect(response!.headers()["content-security-policy"]).toContain("script-src 'self' 'nonce-");
  await expect(page.getByRole("heading", { name: "Ask Flo", level: 1 })).toBeVisible();
  await expect(page.getByText("Your question goes to Anthropic (Claude) and is answered only from the public docs.")).toBeVisible();
  await expect(page.locator(".status.on")).toHaveCount(2);
  await expect(page.getByText("Questions and answers are not stored.")).toBeVisible();
  await page.getByRole("link", { name: "Deutsch" }).click();
  await expect(page.getByRole("heading", { name: "Frag Flo", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByText("Deine Frage geht an Anthropic (Claude) und wird nur aus den öffentlichen Docs beantwortet.")).toBeVisible();
  expect(await context.cookies()).toEqual([]);
  expect(csp).toEqual([]);
  // Phone width: no horizontal scrolling.
  await page.setViewportSize({ width: 360, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.close();
});

test("the public status: no numbers, CORS for the docs only", async ({ request }) => {
  const ok = await request.get("/api/status", { headers: { Origin: "https://docs.flowplan.org" } });
  expect(await ok.json()).toEqual({ docs: true, discord: true, name: "Flo" });
  expect(ok.headers()["access-control-allow-origin"]).toBe("https://docs.flowplan.org");
  const other = await request.get("/api/status", { headers: { Origin: "https://evil.example" } });
  expect(other.headers()["access-control-allow-origin"]).toBeUndefined();
  expect((await request.get("/api/admin/summary")).status()).toBe(404);
});
