// Playwright's default headless Chromium fails basic bot checks (Cloudflare, etc.) on two
// obvious signals: navigator.webdriver === true, and a "HeadlessChrome" UA string. Patching
// these doesn't defeat serious anti-bot systems (JS challenges, CAPTCHAs), but it clears the
// low bar that a lot of ordinary sites actually check.
export const STEALTH_INIT_SCRIPT = `(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
})();`;

export const DESKTOP_CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
