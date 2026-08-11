# Ditch

一個以 web server 形式運作的 live-stream-downloader：使用者提交網頁網址，伺服器自行偵測頁面中的可下載串流／媒體項目，並將使用者選定的項目下載、儲存到伺服器本機磁碟。單人自架工具，不含帳號系統。

## Language

**Candidate**:
針對某個頁面網址執行偵測後，找到的一筆可能可下載的串流／媒體項目，呈現在清單中供使用者挑選。本身尚未下載；若受 DRM 保護則標示為不可下載，但仍列出讓使用者知道原因。
_Avoid_: Stream（過於籠統，未區分「偵測到的候選項目」與「實際串流資料」）、Item

**Detection Session**:
針對單一頁面網址啟動無頭瀏覽器、載入頁面並執行偵測邏輯，產出一份 Candidate 清單的一次操作。
_Avoid_: Scan, Crawl

**Download Job**:
使用者從某次 Detection Session 的 Candidate 清單中選定一項、並指定 Destination Folder 後，伺服器據此抓取媒體片段、視需要解密、輸出成單一檔案並存到本機該資料夾的一次任務；具備可追蹤的進度。
_Avoid_: Task, Recording（本專案不含開放式直播錄製，只做單一影片下載）

**Destination Folder**:
使用者為某次 Download Job 指定、位於 `DOWNLOADS_DIR` 底下的子資料夾路徑，決定完成後的檔案存放位置；可以是根目錄本身，也可以是任意深度的巢狀子資料夾，送出下載請求前透過資料夾選擇視窗設定，尚不存在的子資料夾可在選擇當下新建。
_Avoid_: Path, Output Directory（容易跟代表整個伺服器設定值的 `DOWNLOADS_DIR` 混淆）
