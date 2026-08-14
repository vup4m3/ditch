---
status: accepted
---

# 新增可設定的同時下載上限，超額的 Download Job 進佇列等待

目前系統對同時能跑幾個 Download Job 完全沒有限制：`POST /api/downloads` 一送出就立刻開始執行，無論當下已經有幾個任務在跑。這其實藏著資源風險——`pending` 階段的 `resolveSegments`（`src/download/resolveSegments.ts`）跟 `downloading` 階段的 segment 抓取（`src/download/job.ts`）都可能各自觸發一次 `createBrowserSession`（ADR-0003/0004 的 headless Chromium fallback，CDN 擋 Node fetch 時才會用到），使用者一次選好幾個候選項目下載，就可能同時開出好幾個 Chromium 實例，在資源有限的自架主機上很容易把記憶體/CPU 吃滿。

新增一個使用者可設定的「同時下載上限」：`JobStatus` 擴充成 `queued → pending → downloading → moving → completed/failed`。名額範圍是 `queued`（等待名額）、`pending`、`downloading` 三個階段——這三者都可能牽涉到 Chromium 實例，是同一種資源瓶頸；`moving`（搬到 `DOWNLOADS_DIR`，見 ADR-0005）純粹是檔案 I/O，跟 Chromium 無關，不佔名額。超過上限的新任務直接建立為 `queued`，不拒絕使用者、不需要手動重試；名額釋出時（任務進入 `moving`/`completed`/`failed`）依 `createdAt` 先進先出自動遞補下一個 `queued` 任務。

上限值不做動態偵測系統資源，而是讓使用者在前端新增的 Settings 區塊裡手動輸入一個整數，存進新的 `settings` key-value 資料表（沿用現有 `node:sqlite`，跟 `download_jobs` 同一顆 DB 檔案）。從未設定過時預設為 3；驗證只擋 0 以下（會讓佇列永遠卡死），不設硬性上限，UI 用提示文字建議使用者依主機規格自行拿捏。調整上限會立即生效：調高會嘗試遞補 `queued` 任務；調低絕不會砍掉正在跑的任務，只是之後少開新的，直到低於新上限。

`queued` 任務目前唯一可以被使用者主動取消（新的 `DELETE /api/downloads/:id`，只對 `queued` 生效）——這是系統第一個「取消下載」的操作。已經進入 `pending` 以後的任務代表已經在佔用名額實際做事，維持不可取消，跟「調低上限不砍正在跑的任務」是同一個立場。

伺服器重啟時，`failAllInProgress()` 目前會把 `pending`/`downloading`/`moving` 全部標記失敗（既有「不 resume」政策，因為這幾個階段都有實際檔案/瀏覽器狀態，猜不準進度、resume 不值得做）。`queued` 是這個政策的第一個例外：`queued` 任務還沒實際做任何事，重啟後直接留在佇列裡等待重新取得名額，不會跟著被標記失敗。

這次的上限只涵蓋 Download Job；Detection Session（`src/detection/session.ts` 的偵測流程，同樣會開一個 headless Chromium）不在範圍內，仍然完全不受限，留給未來另一個 ADR 處理。

## Considered options

- **動態依主機 CPU/記憶體計算上限**：不需要使用者操作，但自架主機規格差異很大，使用者自己最清楚要留多少資源給其他服務，自動計算的投報比低，且增加一段不透明的「猜測邏輯」。
- **超過上限直接拒絕新請求（`409`/`429`），不提供佇列**：實作最簡單，但這是單人自架工具、使用者一次選好幾個候選項目下載很常見，直接拒絕會逼使用者自己手動盯著重試，體驗差。
- **名額只算 `downloading` 階段**：原本考慮過，但 `pending` 階段的 `resolveSegments` 一樣可能觸發 Chromium fallback，只擋 `downloading` 擋不住真正的資源尖峰，等於白做。
- **上限值走環境變數**（比照 `CACHE_DIR`/`DOWNLOADS_DIR`/`PUID`/`PGID` 的既有模式）：跟現有設定模式一致、實作更簡單，但改動需要重啟容器，使用者沒辦法在不中斷服務的情況下臨時調整，體驗不如 UI 可調設定。

## Consequences

- `JobStatus` 型別、`jobStore.ts`、前端 `statusLabel`/徽章樣式都要跟著擴充 `queued` 狀態（以及取消對應的最終狀態）。
- `app.ts` 需要維護目前佔用中的名額數（`queued`/`pending`/`downloading` 任務數），並在任務進入/離開這三個狀態、或 Settings 上限被調整時觸發佇列遞補邏輯。
- `jobStore.failAllInProgress()` 需要排除 `queued`，是「不 resume」政策的第一個例外，日後看到類似情境（某狀態本身沒有實際副作用）可以參考同樣的判斷。
- 新增系統第一個可以主動中止任務的 API（`DELETE /api/downloads/:id`），但範圍限定在 `queued`，不影響既有「已執行的任務不能被砍」的假設。
- Detection Session 端的 Chromium 用量依然不受限，若未來也需要限制，會是另一個獨立的設計。
