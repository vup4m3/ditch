---
status: accepted
---

# Download Job 在 Node 端獨立發送請求，不在無頭瀏覽器分頁 context 內執行

無頭瀏覽器偵測到 Candidate 後，選擇擷取當下分頁的 Referer/Cookie/User-Agent，交給 Node 獨立發 fetch 抓取 segment 並解密輸出，而不是在瀏覽器分頁的 page context 內（如透過 `page.evaluate` 呼叫原生 fetch/WebCrypto）執行整個下載流程。這讓 Node 端可以用 stream 直接寫檔、更好掌控併發與效能，也不需要讓瀏覽器分頁長時間佔用資源處理下載。

## Consequences

遇到需要瀏覽器獨有狀態（例如短效 token 綁定呼叫來源）的網站，可能會抓取失敗，屬於已知限制。
