---
status: accepted
---

# 新增瀏覽器 fallback，因應 Node fetch 被 CDN 封鎖的網站

ADR-0003 選擇 Download Job 用 Node 端獨立 fetch，並預期「遇到需要瀏覽器獨有狀態的網站可能抓取失敗」是已知限制。實際測試中發現這個限制比預期更常見：像 Cloudflare 這類 CDN 防護，就算 Node 端帶上跟瀏覽器一致的 Referer/User-Agent，仍會回傳 403——因為擋下的判斷依據包含 TLS/HTTP2 層的指紋與瀏覽器過關後拿到的 clearance cookie，這些都是單純複製 headers 補不回來的。

驗證發現：在「已經通過該網站反機器人檢查」的同一個瀏覽器分頁 context 內，用原生 `fetch()` 重新抓同一個網址可以成功。因此新增 fallback：Download Job 與 `resolveSegments` 都先嘗試 Node 端 fetch（快、多數網站適用），只有在失敗時才用無頭瀏覽器重新造訪來源頁面（`referer`）建立 session，並在該瀏覽器 context 內完成後續的抓取；同一個 Download Job 內若已經觸發過 fallback，會重複使用同一個瀏覽器 session，不會每個 segment 都重開瀏覽器。

同時把偵測階段使用的基本反偵測措施（覆寫 `navigator.webdriver`、換成一般桌面版 Chrome 的 User-Agent，而非預設會暴露 `HeadlessChrome` 字樣的無頭瀏覽器指紋）抽成共用模組，讓下載階段的 fallback session 也套用同一套設定。

## Considered options

- 全面改成都在瀏覽器 context 內下載（推翻 ADR-0003 的核心選擇）：對受保護的網站更可靠，但放棄 Node 端 stream 直接寫檔、多工下載的效能與併發優勢，多數不需要繞過反爬蟲的網站也要付出這個成本。

## Consequences

- 需要為每個真正觸發 fallback 的 Download Job 額外啟動一個無頭瀏覽器（多幾秒的啟動成本），但只在 Node fetch 真的失敗時才發生。
- 反偵測措施只能繞過基本檢查（UA 字串、`navigator.webdriver`），遇到更進階的機制（JS 挑戰、CAPTCHA/Turnstile）預期仍會失敗，沒有真正的解法。
