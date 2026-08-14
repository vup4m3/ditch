---
status: accepted
---

# 候選項目縮圖：Playwright 截圖為主、頁面 meta 為輔，Session 層級共用一張

偵測完成後，Candidate 清單目前只有文字（類型、畫質標籤、檔名輸入框），使用者送出下載前沒辦法先確認「這是不是我要的那支影片」。新增縮圖顯示，來源優先序：

1. **Playwright screenshot**：`session.ts` 的偵測流程本來就會啟動 headless Chromium 載入頁面、對每個 `<video>` 元素呼叫 `play()`，並等待 `timeoutMs`（預設 8 秒）——這段期間影片已經在頁面上播放。在關閉瀏覽器前，對渲染尺寸最大的 `<video>` 元素（`getBoundingClientRect()` 比較）呼叫 Playwright 的 element screenshot，直接拿到一張真實畫面。這個做法不需要 ffmpeg（ADR-0002 明確禁用），Playwright 本身已經是既有依賴；而且 element screenshot 是瀏覽器渲染層直接截圖，不像 `canvas.toDataURL()` 那樣會被跨網域／DRM 內容的畫布安全限制擋住，DRM 保護的候選項目一樣拍得到縮圖（只是仍然不能下載）。
2. 頁面上沒有 `<video>` 元素、或截圖失敗，退回讀 `<meta property="og:image">` 或 `<video poster>`，伺服器端代為抓取這個 URL 的圖片位元組。
3. 兩者都沒有，前端顯示佔位圖示，不留空白版面。

縮圖是 **Detection Session 層級共用一張**，不逐一配對每個 Candidate 到特定 `<video>` 元素——同一次偵測的 Candidate 通常是同一支影片的不同畫質（例如 HLS master playlist 展開的多個變體），配對到同一個播放器上的畫面沒有意義上的差異；這跟既有的 `pageTitle`（`session.ts`，同一次偵測所有 Candidate 共用同一個預設檔名來源）是同一種設計精神。真的有頁面同時播放兩支完全不同的影片是少數情境，不值得為此把「Candidate URL 對到哪個 `<video>` 元素」這種配對邏輯複雜化。

傳輸走新增的 `GET /api/detections/:id/thumbnail`（Session 層級，不是 Candidate 層級），前端用 `<img>` 惰性載入。Candidate 本身透過 SSE 即時推送（既有的「即時列表」設計），縮圖天生會比 Candidate 晚到（影片要先播放一陣子才有畫面可截），如果把縮圖內嵌進 SSE payload 會拖慢 Candidate 列表本身的即時性；獨立 endpoint 讓兩者的時間軸互不干擾，瀏覽器原生的圖片載入行為就自然處理了「縮圖晚一點才顯示」這件事，不用自己刻輪詢或新的 SSE 事件類型。

縮圖資料（screenshot 的 buffer，或代抓的 `og:image`/`poster` 位元組）存在既有的 `DetectionEntry`（`detections` 這個記憶體 `Map`）新增的欄位上，跟整個 Detection Session 一樣純記憶體、伺服器重啟就消失，不另外存檔或存 DB——這個專案裡 Detection Session 本來就沒有 resume 機制。

## Considered options

- **用 ffmpeg 從下載好的影片截一幀**：畫質/格式最穩定，但直接違反 ADR-0002「零額外二進位依賴」的決定，而且縮圖應該在下載前就給使用者看，不能等下載完才有。
- **只用 `<video>` 的 `canvas.drawImage()` + `toDataURL()`**：不用另外呼叫 Playwright API，但跨網域或 DRM 保護的影片會直接被瀏覽器的畫布安全限制擋下（拋 `SecurityError` 或回傳全黑），這正是這個工具主要處理的內容類型，等於大多數情境都拿不到縮圖。
- **逐一配對每個 Candidate 到對應的 `<video>` 元素**（比對 `src`/`currentSrc` 跟 Candidate URL）：理論上更精準，但 Candidate 的 URL 常常是子清單/畫質變體的 URL，不見得跟 `<video>` 的 `src`/`currentSrc` 對得上，配對邏輯的複雜度跟實際帶來的價值不成比例。
- **縮圖內嵌進 SSE 的 `candidate` 事件**：省了一支新 endpoint，但會讓 Candidate 列表的即時性被縮圖的產生時間拖住（截圖得等影片有畫面可截）。

## Consequences

- `session.ts` 多一段截圖／退回邏輯，在 `browser.close()` 前執行，會讓 Detection Session 的總耗時略增（截圖本身很快，主要成本還是既有的 `timeoutMs` 等待）。
- `DetectionEntry` 多一個欄位存縮圖 buffer，`detections` 這個記憶體 Map 本來就沒有清理機制（伺服器不重啟就會一直累積），縮圖會讓每筆 entry 的記憶體佔用變大，長期需要的話之後可以另外做過期清理，這次不處理。
- 縮圖是 Session 共用，如果同一頁面真的有兩支不同的影片被偵測成不同 Candidate，使用者會看到「所有候選項目都是同一張縮圖」，可能誤以為偵測錯誤——這是刻意接受的取捨（見上面 Considered options 的配對複雜度理由）。
