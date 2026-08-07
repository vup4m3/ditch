import { chromium } from "playwright";
import { STEALTH_INIT_SCRIPT } from "../detection/stealth.ts";

export interface BrowserSession {
  /** Fetches a URL using the warmed-up page's own fetch() — carries whatever cookies/session
   * the browser earned by visiting the warm-up page (e.g. a Cloudflare clearance cookie) that
   * a plain Node-side fetch has no way to replicate (see ADR-0003). */
  fetchBuffer(url: string): Promise<Buffer>;
  close(): Promise<void>;
}

/**
 * Launches a headless browser, visits `warmupUrl` once to establish cookies/session state,
 * and returns a session that can fetch further URLs through that same browser context.
 */
export async function createBrowserSession(warmupUrl: string, userAgent: string): Promise<BrowserSession> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent });
  const page = await context.newPage();
  await page.addInitScript(STEALTH_INIT_SCRIPT);

  try {
    await page.goto(warmupUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
  } catch {
    // best-effort warm-up — if it fails, let the actual fetchBuffer calls surface the real error
  }

  return {
    async fetchBuffer(url: string): Promise<Buffer> {
      const bytes = await page.evaluate(async (u) => {
        const res = await fetch(u);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return new Uint8Array(await res.arrayBuffer());
      }, url);
      return Buffer.from(bytes);
    },
    async close(): Promise<void> {
      await browser.close();
    },
  };
}
