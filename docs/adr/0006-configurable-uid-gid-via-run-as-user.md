---
status: accepted
---

# 用 `docker run --user` / compose `user:` 讓容器以指定 UID/GID 執行，而非 entrypoint + gosu

容器原本沒有指定執行身分，預設用 base image 的 root。這對本機 bind mount（`CACHE_DIR`、`DOWNLOADS_DIR`、DB 目錄）是個問題：容器寫出的檔案/資料夾在 host 上會是 root 所有，NFS 目的地更嚴重——大多數 NFS 伺服器預設開 `root_squash`，容器內的 root 寫入時會被伺服器端映射成匿名使用者，輕則檔案權限混亂，重則直接寫入失敗。

改成讓容器以指定的 UID/GID 執行，寫出的檔案就直接是那個使用者所有，跟自架這台機器上其他服務（NFS export 用一般使用者，不開 root）的慣例一致。

具體作法：Dockerfile 用 `USER 1000:1000` 設一個安全的預設值（image 內建的非 root 使用者），docker-compose.yml 用 `user: "${PUID:-1000}:${PGID:-1000}"` 蓋掉它，讓使用者透過 `.env` 檔或 shell 環境變數指定要跑成哪個 UID/GID，不需要重新 build image。

這同時解決了另一個問題：Chromium 自己的 sandbox 在偵測到「啟動它的行程是 root」時會直接拒絕初始化（root 逃脫自己的 sandbox沒有意義，所以乾脆不讓用）。用 root 執行 Playwright 通常得額外加 `--no-sandbox` 參數才跑得動；改成非 root 執行後，sandbox 才是真的在生效，不只是檔案權限變乾淨而已。

## Considered options

- **entrypoint script + `gosu`／`su-exec`，容器內動態依 `PUID`/`PGID` 建立使用者再切換身分**：像 linuxserver.io 系列 image 的做法，好處是能在容器內用 root 身分先把 `/data` 底下的目錄 `chown` 成指定的 UID/GID，使用者完全不用碰 host 端權限。捨棄的原因：`DOWNLOADS_DIR` 預期指向 NFS，容器每次啟動都對它跑一次遞迴 `chown` 既慢、對已經放滿影片的目的地也沒必要，還多了一層 entrypoint 腳本的維護成本。
- **在 Dockerfile 用固定 `USER` 硬編一組 UID/GID，不做成可設定的**：最簡單，但不同機器上部署者的使用者 UID 本來就不一定是 1000（尤其這台機器很多服務就是這樣），沒得覆蓋就直接違背這次的需求。

## Consequences

- 部署者要自己確保 bind mount 的 host 目錄（`cache`、`downloads`、db 所在目錄）本來就是那組 PUID/PGID 可寫的——容器不會、也不會嘗試自動 `chown` 它們。首次部署時要記得對照 README 手動 `chown`/`mkdir`。
- `.env` 檔沒設 `PUID`/`PGID` 時預設走 image 內建的 `1000:1000`，跟大多數 Linux 桌機的第一個一般使用者 UID 一致，多數單機自架情境不用另外設定就能動。
