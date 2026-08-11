---
status: accepted
---

# Download Job 先寫入本機 SSD cache，完成後才搬移到最終目的地（可為 NFS）

> **更新**：本文提到「`DOWNLOADS_DIR` 是扁平目錄」的部分已被 [ADR-0008](./0008-nested-destination-folders.md) 取代為可巢狀子目錄；以下關於 SSD cache 兩段式搬移、`rename()`/`EXDEV` fallback 的決策維持不變。

原本 Download Job 直接把 segment 寫進 `DOWNLOADS_DIR` 底下的目的檔案。當 `DOWNLOADS_DIR` 指向網路掛載（例如 NFS）時，這代表整段下載期間（可能是數千次 segment write）都直接對網路檔案系統發 I/O：延遲較高、偶發性斷線/卡頓會直接中斷寫入中的檔案，且下載到一半的檔案會被使用者在目的地資料夾直接看到。

改為兩段式：Download Job 先把 segment 寫進 `CACHE_DIR`（預期指向本機 SSD，低延遲、可靠）底下的 `<jobId>/<filename>`，寫完之後才整份搬到 `DOWNLOADS_DIR`（可為 NFS）底下、與使用者輸入完全一致的 `<filename>`——`DOWNLOADS_DIR` 是扁平目錄，不會像 cache 那樣用 job id 分子資料夾包起來，這樣使用者直接去目的地資料夾找檔案時，看到的名字就是自己打的那個。搬移期間任務狀態為 `moving`。

搬移邏輯（`src/download/relocateFile.ts`）優先用 `rename()`：如果 cache 和目的地剛好在同一個檔案系統（例如純本機部署，兩者都在同一顆硬碟），這是原子操作、幾乎瞬間完成。只有當 `rename()` 因跨檔案系統而回傳 `EXDEV`（SSD → NFS 是典型情境）才 fallback 成 `copyFile()` + `unlink()`。

任務狀態新增 `moving`，供前端顯示「搬移到目的地中…」；伺服器重啟時 `failAllInProgress()` 也會把卡在 `moving` 的任務一併標記失敗（跟 `pending`/`downloading` 一致，沒有斷點續傳）。

因為目的地是扁平目錄，兩個任務打同一個檔名就會真的撞在一起。作法不是自動改名（例如加 `(1)`），而是在**送出下載請求當下**（開始抓 segment 之前）就先檢查 `DOWNLOADS_DIR` 底下是否已有同名檔案：若有，`POST /api/downloads` 回傳 `409 { error: "filename_conflict", filename }`，不建立任務；前端跳出確認對話框讓使用者選擇「覆蓋」（帶著 `overwrite: true` 重送一次請求）或「取消」（什麼都不做）。選擇覆蓋後，最終搬移會直接寫到同一個路徑，蓋掉舊檔（`rename()`/`copyFile()` 對已存在的目的檔案本來就是覆蓋語意，不需要額外刪除步驟）。

## Considered options

- **維持只寫一次到最終目的地**：實作最簡單，但目的地是 NFS 時整段下載都暴露在網路檔案系統的延遲/不穩定下，而且沒有「寫入中」與「已完成」的區隔。
- **下載期間先寫到記憶體（Buffer）最後一次性寫檔**：省去搬移步驟，但長時間直播下載的檔案可能遠超可用記憶體，不可行。
- **撞名時自動改名（`name (1).ext`）**：不需要使用者互動、行為跟瀏覽器下載同名檔案一致，但使用者原本想覆蓋舊檔（例如重下失敗的檔案）時反而會意外產生一堆編號檔案，不易察覺、需要事後手動清。改成「先跳警告，使用者自己決定覆蓋或取消」更符合這個工具單人自架、操作者清楚自己在做什麼的定位。

## Consequences

- 多一段「搬移」時間：cache 與目的地不同檔案系統時（例如 SSD → NFS）需要整份複製一次，會讓大檔案的「完成」時間點延後於「下載完成」；此區間對使用者呈現為 `moving` 狀態。
- 需要保留兩份設定（`CACHE_DIR`、`DOWNLOADS_DIR`）與兩份磁碟空間（複製期間 cache 與目的地會同時各有一份完整檔案），部署時 cache 磁碟需預留至少一部影片的空間。
- 搬移失敗（例如 NFS 當下不可寫）目前直接讓任務失敗，cache 裡的檔案不會自動清掉、也沒有自動重試——需要的話留在 cache 供之後手動處理。
