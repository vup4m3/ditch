# Ditch

一個以 web server 形式運作的 live-stream-downloader：使用者提交網頁網址，伺服器自行偵測頁面中的可下載串流／媒體項目，並將使用者選定的項目下載、儲存到伺服器本機磁碟。單人自架工具，不含帳號系統。

## Language

**Candidate**:
針對某個頁面網址執行偵測後，找到的一筆可能可下載的串流／媒體項目，呈現在清單中供使用者挑選。本身尚未下載；若受 DRM 保護則標示為不可下載，但仍列出讓使用者知道原因。
_Avoid_: Stream（過於籠統，未區分「偵測到的候選項目」與「實際串流資料」）、Item

**Detection Session**:
針對單一頁面網址啟動無頭瀏覽器、載入頁面並執行偵測邏輯，產出一份 Candidate 清單的一次操作。
_Avoid_: Scan, Crawl

**Thumbnail（縮圖）**:
一次 Detection Session 底下所有 Candidate 共用的一張畫面，讓使用者在下載前先確認「這是不是我要的影片」。優先用 Playwright 對頁面上渲染尺寸最大的 `<video>` 元素截圖（不需要 ffmpeg，也不受 DRM／跨網域畫布安全限制影響）；截不到才退回讀頁面的 `<meta property="og:image">` 或 `<video poster>`。跟整個 Detection Session 一樣純記憶體、伺服器重啟就消失，不逐一配對到個別 Candidate（同一次偵測的 Candidate 通常是同一支影片的不同畫質，共用一張縮圖）。
_Avoid_: Poster（容易誤以為只從 `<video poster>` 屬性取得，實際上優先來源是截圖）, Preview

**Download Job**:
使用者從某次 Detection Session 的 Candidate 清單中選定一項、並指定 Destination Folder 後，伺服器據此抓取媒體片段、視需要解密、輸出成單一檔案並存到本機該資料夾的一次任務；具備可追蹤的進度。若當下已達 Concurrency Limit，會先以 `queued` 狀態進 Queue 等待，取得執行名額後才真正開始。
_Avoid_: Task, Recording（本專案不含開放式直播錄製，只做單一影片下載）

**Destination Folder**:
使用者為某次 Download Job 指定、位於 `DOWNLOADS_DIR` 底下的子資料夾路徑，決定完成後的檔案存放位置；可以是根目錄本身，也可以是任意深度的巢狀子資料夾，送出下載請求前透過資料夾選擇視窗設定，尚不存在的子資料夾可在選擇當下新建。
_Avoid_: Path, Output Directory（容易跟代表整個伺服器設定值的 `DOWNLOADS_DIR` 混淆）

**Concurrency Limit**:
使用者透過 Settings 設定的整數，決定伺服器同時最多有幾個 Download Job 可以佔用執行名額（`queued`／`pending`／`downloading` 三個階段都算，`moving` 不算，因為前三者可能牽涉 headless Chromium 資源，`moving` 純粹是檔案搬移）。使用者未設定過時預設為 3；可隨時調整，調低不會中止已在執行中的 Download Job。
_Avoid_: Max Downloads（容易誤解成「累計下載總數」而非「同時執行數」）

**Queue**:
因為 Concurrency Limit 已滿而尚未取得執行名額、狀態為 `queued` 的 Download Job 集合，依建立時間先進先出遞補名額。使用者可以取消還在 Queue 中、尚未真正開始執行的 Download Job；已取得名額執行中的則不可取消。
_Avoid_: Waitlist, Backlog

**Delete（刪除歷史紀錄）**:
使用者從下載紀錄中移除一筆已經結束（`completed`／`failed`／`cancelled`）的 Download Job；只清除伺服器內部保存的這筆紀錄本身，不會刪除已下載完成的檔案，也不會清 `CACHE_DIR` 裡任何殘留的暫存檔。跟 Queue 的「取消」是不同語意——取消是在 Download Job 還沒開始執行前不讓它開始，刪除是清掉一件已經結束的事——兩者共用同一個 `DELETE /api/downloads/:id`，依 Download Job 當下的狀態決定實際要做取消還是刪除。
_Avoid_: Remove（容易跟「取消」混為一談）, Clear History（範圍容易誤解成一次清空全部）
