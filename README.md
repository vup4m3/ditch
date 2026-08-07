# ditch

以 web server 形式運作的 live-stream-downloader：貼上網頁網址，伺服器用無頭瀏覽器自行偵測頁面裡可下載的串流／媒體項目，選定後由伺服器抓取並存到本機磁碟。單人自架工具，不含帳號系統。

## 功能

- **偵測**：對任意網頁網址啟動一次無頭瀏覽器（Playwright），找出頁面載入過程中出現的 HLS（`.m3u8`）、DASH（`.mpd`）manifest 或直接影音檔案，即時（SSE）列成候選清單；DRM 保護的項目會標示出來但不能下載。
- **下載**：純 JS/Node 實作，不依賴 ffmpeg。自動解析 manifest 分段、處理 AES-128 解密與 fMP4 init segment，逐段下載併接成單一檔案；進度即時回報。
- **兩段式落地**：下載先寫進本機 cache（建議放 SSD），完成後才整份搬到最終目的地（可以是 NFS 等高延遲掛載），避免整段下載期間都直接對慢速掛載發 I/O。細節見 [`docs/adr/0005`](docs/adr/0005-ssd-cache-before-nfs-destination.md)。
- **撞名保護**：目的地目錄是扁平結構，檔名就是你打的那個；如果目的地已有同名檔案，下載前會先擋下來讓你選擇覆蓋或取消，不會靜默改名或覆蓋。
- **反偵測**：偵測與下載都套用基本反機器人措施（覆寫 `navigator.webdriver`、使用一般桌面版 Chrome UA）；遇到 CDN 封鎖 Node 端 fetch 時，會 fallback 成用同一個已通過驗證的瀏覽器 context 重新抓取。

## 快速開始（Docker）

```bash
git clone git@github.com:vup4m3/ditch.git
cd ditch
docker compose build
docker compose up -d
```

開啟 `http://localhost:3000`，貼上網頁網址即可開始使用。

預設的 `docker-compose.yml` 把 `cache`、`downloads`、`data` 都綁定到專案目錄底下的本機路徑，實際部署時請把 `downloads` 換成你要的最終目的地（可以是 NFS 掛載），`cache` 留在本機 SSD。

### 設定容器執行的 UID/GID

容器預設以 `1000:1000` 執行（非 root——Playwright 的 sandbox 需要非 root 才會生效），寫出的檔案會是這個 UID/GID 所有。如果 bind mount 的 host 目錄（尤其是 NFS 上的 `DOWNLOADS_DIR`）屬於別的使用者，先在專案根目錄放一個 `.env` 檔指定：

```bash
echo "PUID=$(id -u)" >> .env
echo "PGID=$(id -g)" >> .env
```

並確保 `cache`、`downloads`、`data` 這幾個 host 目錄本身就是這組 UID/GID 可寫的（容器不會自動 `chown`，尤其 `downloads` 常指向 NFS，遞迴 chown 一個媒體庫既慢又沒必要）。細節見 [`docs/adr/0006`](docs/adr/0006-configurable-uid-gid-via-run-as-user.md)。

## 環境變數

除了下面這些容器內的環境變數，`docker-compose.yml` 另外還讀取 `PUID`/`PGID`（見上一節）決定容器以哪個身分執行——這兩個不是給 Node process 用的環境變數，純粹是 compose 檔用來組出 `user:` 欄位。

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `PORT` | `3000` | 監聽的 port |
| `CACHE_DIR` | `./cache` | 下載期間的暫存位置，建議本機 SSD |
| `DOWNLOADS_DIR` | `./downloads` | 完成後的最終存放位置，可為 NFS 等網路掛載 |
| `DB_PATH` | `./data/ditch.sqlite` | 任務紀錄用的 SQLite 檔案路徑 |

## 本機開發

需要 Node.js ≥ 24（原生 `node:sqlite` 支援）。

```bash
npm install
npm run dev         # node --watch 啟動開發伺服器
npm run typecheck   # tsc --noEmit
npm test            # node:test，跑 src 底下所有 *.test.ts
npm run build       # 編譯到 dist/，供 npm start 使用
```

## 架構概覽

1. `POST /api/detections` 啟動一次 Detection Session（無頭瀏覽器載入頁面），透過 SSE 即時推送找到的 Candidate。
2. `POST /api/downloads` 依選定的 Candidate 建立 Download Job：解析 manifest 分段 → 寫入 `CACHE_DIR` → 搬移到 `DOWNLOADS_DIR` → 標記完成，任務狀態（`pending` → `downloading` → `moving` → `completed`/`failed`）與進度都持久化在 SQLite，並透過 SSE 即時推送給前端。
3. `GET /api/downloads/:id/file` 提供完成檔案的下載。

專案裡的領域詞彙（Candidate / Detection Session / Download Job）定義在 [`CONTEXT.md`](CONTEXT.md)；重要架構決策記錄在 [`docs/adr/`](docs/adr/)。

## 注意事項

這個工具沒有帳號驗證，`docker-compose.yml` 預設把 port 綁在 `0.0.0.0`（區網內都連得到）。設計上只適合放在信任的區網環境自用，**不要**直接對外網開放；若要對外提供服務，請自行加上驗證或反向代理。

## License

MIT
