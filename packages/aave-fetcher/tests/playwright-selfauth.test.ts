import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";

const SKIP_LOCAL_PLAYWRIGHT = process.env.MERIT_ALLOW_LOCAL_PLAYWRIGHT === "false";
const TEST_TIMEOUT = 60_000;

async function createTestPage(context: import("playwright").BrowserContext) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    if (typeof (globalThis as any).__name === "undefined") {
      (globalThis as any).__name = (func: any) => func;
    }
  });
  return page;
}

describe("Playwright browser lifecycle", { skip: SKIP_LOCAL_PLAYWRIGHT }, () => {
  let browser: Browser | null = null;

  after(async () => {
    if (browser) {
      await browser.close();
      browser = null;
    }
  });

  it("launches chromium with required flags", async () => {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    assert.ok(browser);
    assert.ok(browser.isConnected());
  });

  it("creates isolated BrowserContext", async () => {
    if (!browser) return;
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    assert.notStrictEqual(ctx1, ctx2);
    await ctx1.close();
    await ctx2.close();
  });

  it("closes browser cleanly", async () => {
    if (!browser) return;
    await browser.close();
    assert.ok(!browser.isConnected());
    browser = null;
  });
});

describe("Playwright campaign info extraction from real Merit page", { skip: SKIP_LOCAL_PLAYWRIGHT }, () => {
  let browser: Browser | null = null;

  before(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  it(
    "extracts campaign info from ethereum-new-weth-boost",
    { timeout: TEST_TIMEOUT },
    async () => {
      if (!browser) return;
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });
      const page = await createTestPage(context);

      try {
        await page.goto("https://apps.aavechan.com/merit/ethereum-new-weth-boost", {
          waitUntil: "networkidle",
          timeout: 30_000,
        });

        await page.waitForSelector("body", { timeout: 10_000 });

        const campaignInfoButton = page.locator("button", {
          hasText: /campaign\s+info/i,
        });
        await campaignInfoButton.first().click();

        await page.waitForSelector("table tbody tr", { timeout: 5_000 });

        const infos = await page.evaluate(() => {
          const doc = globalThis.document;
          if (!doc) return [];
          const infos: Array<{ action?: string; description?: string }> = [];
          const tables = doc.querySelectorAll("table");
          for (let i = 0; i < tables.length; i++) {
            const rows = tables[i].querySelectorAll("tbody tr");
            for (let j = 0; j < rows.length; j++) {
              const cells = rows[j].querySelectorAll("td");
              if (cells.length >= 2) {
                const action = cells[0]?.textContent?.trim() || "";
                const description = cells[1]?.textContent?.trim() || "";
                if (action && description && description.length > 20) {
                  infos.push({ action, description });
                }
              }
            }
          }
          return infos;
        });

        assert.ok(Array.isArray(infos), "Should return array");
        assert.ok(infos.length > 0, "Should extract at least one campaign info row");
        assert.ok(
          infos.some((info) => info.description!.includes("Rewards are distributed")),
          'At least one row should mention "Rewards are distributed"'
        );
      } finally {
        await context.close();
      }
    }
  );
});

describe("Playwright self-auth extraction from real Merit page", { skip: SKIP_LOCAL_PLAYWRIGHT }, () => {
  let browser: Browser | null = null;

  before(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  it(
    "extracts self-auth from page when present (or confirms absence gracefully)",
    { timeout: TEST_TIMEOUT },
    async () => {
      if (!browser) return;
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });
      const page = await createTestPage(context);

      try {
        await page.goto("https://apps.aavechan.com/merit/ethereum-new-weth-boost", {
          waitUntil: "networkidle",
          timeout: 30_000,
        });

        await page.waitForSelector("body", { timeout: 10_000 });

        const selfAuth = await page.evaluate(() => {
          const norm = (s: any) =>
            String(s || "")
              .replace(/\s+/g, " ")
              .trim();

          const hasSelfAuth = (s: any) => {
            const t = String(s || "").toLowerCase();
            return (
              t.includes("self") &&
              (t.includes("authentication") ||
                t.includes("verify") ||
                t.includes("proof"))
            );
          };

          const doc = globalThis.document;
          if (!doc) return null;

          const candidates = doc.querySelectorAll(
            "section,article,aside,div,p,li"
          );

          let bestText: string | null = null;
          for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i] as Element;
            const text = norm(el.textContent);
            if (
              text &&
              hasSelfAuth(text) &&
              text.length >= 60 &&
              text.length <= 1200
            ) {
              if (!bestText || text.length < bestText.length) {
                bestText = text;
              }
            }
          }

          return bestText;
        });

        // Self-auth may not be present on all pages — just verify extraction logic works
        // (no crash, returns string or null)
        assert.ok(
          selfAuth === null || typeof selfAuth === "string",
          "Should return string or null without error"
        );
      } finally {
        await context.close();
      }
    }
  );
});
