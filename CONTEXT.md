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

**Suggested Filename（建議檔名）**:
偵測完成後，清單中每個 Candidate 都預先帶一個檔名，供使用者在送出 Download Job 前直接採用或修改。內容衍生自該次 Detection Session 的頁面標題，並去掉標題常見的網站／頻道樣板後綴、必要時再把過長的部分裁短；副檔名依 Candidate 的媒體類型決定。純屬建議值，使用者一旦手動改過就不再被自動更新，也可以完全覆寫；頁面標題不可用時退回通用名稱。使用者最終送出的檔名字串若長到危及檔案系統的單檔名上限，伺服器會再自行裁短一次，這是與「建議檔名」相互獨立的一道保護。
_Avoid_: Default Filename（與伺服器在完全沒有檔名時採用的通用退路名稱混淆）, Title（那是頁面未經清理與裁短的原始標題）

**Download Job**:
使用者從某次 Detection Session 的 Candidate 清單中選定一項、並指定 Destination Folder 後，伺服器據此抓取媒體片段、視需要解密、輸出成單一檔案並存到本機該資料夾的一次任務；具備可追蹤的進度。若當下已達 Concurrency Limit，會先以 `queued` 狀態進 Queue 等待，取得執行名額後才真正開始。若 Job 建立當下的全域「是否轉檔」設定為開啟，下載完成後還會多經過一次 Transcode 才算真正完成（見該詞條）；建立之後才調整設定不會影響這個 Job。
_Avoid_: Task, Recording（本專案不含開放式直播錄製，只做單一影片下載）

**Destination Folder**:
使用者為某次 Download Job 指定、位於 `DOWNLOADS_DIR` 底下的子資料夾路徑，決定完成後的檔案存放位置；可以是根目錄本身，也可以是任意深度的巢狀子資料夾，送出下載請求前透過資料夾選擇視窗設定，尚不存在的子資料夾可在選擇當下新建。
_Avoid_: Path, Output Directory（容易跟代表整個伺服器設定值的 `DOWNLOADS_DIR` 混淆）

**Concurrency Limit**:
使用者透過 Settings 設定的整數，決定伺服器同時最多有幾個 Download Job 可以佔用執行名額（`queued`／`pending`／`downloading` 三個階段都算，`moving` 不算，因為前三者可能牽涉 headless Chromium 資源，`moving` 純粹是檔案搬移）。使用者未設定過時預設為 3；可隨時調整，調低不會中止已在執行中的 Download Job。
_Avoid_: Max Downloads（容易誤解成「累計下載總數」而非「同時執行數」）

**Queue**:
因為 Concurrency Limit 已滿而尚未取得執行名額、狀態為 `queued` 的 Download Job 集合，依建立時間先進先出遞補名額。使用者可以取消還在 Queue 中、尚未真正開始下載的 Download Job；已取得下載名額、正在 `downloading`／`pending`／`moving` 的則不可取消（`transcodeQueued`／`transcoding` 兩階段例外，見 Transcode Queue）。
_Avoid_: Waitlist, Backlog, Transcode Queue（管的是轉檔名額而非下載名額，是另一個獨立的等待佇列，見該詞條）

**Transcode（轉檔）**:
Download Job 下載完原始媒體資料、原始檔已在 cache 後，若該 Job 建立當下的全域「是否轉檔」設定為開啟，就會多執行的一個步驟：用 ffmpeg（`libsvtav1` 編碼器）把影像軌重新編碼成 AV1，音訊軌以 stream copy 方式原樣封裝，輸出成單一 `.mkv` 檔案；成功後刪除轉檔前的原始檔，並讓最終輸出檔名的副檔名強制為 `.mkv`（覆蓋使用者輸入的檔名副檔名）。只套用在含有影像軌的來源——純音訊來源（例如偵測到的 `.mp3`／`.m4a` 直接檔案 Candidate）不受影響，照原樣下載存檔。畫質／速度取捨（preset、CRF）目前是寫死的固定值，不開放調整；也不偵測來源是否已經是 AV1，一律重新編碼。轉檔本身也可能因為 Transcode Concurrency Limit 已滿而先進 Transcode Queue 等待。
_Avoid_: Convert, Encode（籠統，未區分這是專案裡固定的「輸出 MKV/AV1」這一種轉檔，不是泛用轉檔器）, Compress（容易誤以為目的是省空間，實際上是統一輸出格式）

**Transcode Concurrency Limit**:
使用者透過 Settings 設定的整數，決定伺服器同時最多有幾個 Download Job 可以佔用轉檔執行名額（`transcodeQueued`／`transcoding` 兩階段算），跟決定下載名額的 Concurrency Limit 是完全獨立的兩個池子、兩個設定值——AV1 軟體編碼非常吃 CPU，跟下載時佔用的瀏覽器／網路資源是不同種類的瓶頸，混在同一個名額池會讓兩者互相卡住。使用者未設定過時預設為 1；可隨時調整，調低不會中止已在轉檔中的 Download Job。
_Avoid_: Concurrency Limit（那是下載名額，不是轉檔名額，兩者容易混淆但管的是不同資源）

**Transcode Queue（轉檔佇列）**:
下載已完成、原始檔已在 cache，但因為 Transcode Concurrency Limit 已滿而尚未取得轉檔執行名額、狀態為 `transcodeQueued` 的 Download Job 集合，依先進先出遞補名額，行為比照 Queue，但是完全獨立的等待佇列與名額池，不要跟 Queue 搞混。一個 Download Job 可能兩個佇列都經過（先在 Queue 等下載名額，下載完再進 Transcode Queue 等轉檔名額），也可能都不經過（該 Job 建立當下轉檔設定為關閉時，完全跳過這一步）。跟 Queue 不同的是：使用者不只能取消還在 Transcode Queue 中等待的 Download Job，連正在 `transcoding`（ffmpeg 執行中）的也可以取消——中止 ffmpeg 行程、刪除半成品輸出檔（因為 kill 一個 ffmpeg 行程是乾淨、安全的操作，不像下載階段的瀏覽器資源那樣難以安全中途收尾）。
_Avoid_: Queue（是另一個獨立概念，管的是下載名額而非轉檔名額）

**Delete（刪除歷史紀錄）**:
使用者從下載紀錄中移除一筆已經結束（`completed`／`failed`／`cancelled`）的 Download Job；只清除伺服器內部保存的這筆紀錄本身，不會刪除已下載完成的檔案，也不會清 `CACHE_DIR` 裡任何殘留的暫存檔。跟「取消」是不同語意——取消是讓一個還沒真正跑完的 Job 提前結束（依所在階段，可能是不讓它開始下載，也可能是中止正在跑的轉檔行程），刪除是清掉一件已經結束的事——兩者共用同一個 `DELETE /api/downloads/:id`，依 Download Job 當下的狀態決定實際要做取消還是刪除。
_Avoid_: Remove（容易跟「取消」混為一談）, Clear History（範圍容易誤解成一次清空全部）
