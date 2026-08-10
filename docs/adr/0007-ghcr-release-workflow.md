---
status: accepted
---

# 打 git tag 時用 GitHub Actions 建置並推送 image 到 GHCR，而非 Docker Hub

README 目前的安裝方式是 `git clone` + `docker compose build`，對這種自架單人工具已經夠用，但每次部署都要重新 build（含 Playwright/Chromium 那層）稍慢。改成打 `v*` git tag 時由 GitHub Actions 自動 build 並推到 GHCR（`ghcr.io/vup4m3/ditch`），部署端就能直接 `docker pull` 現成的 image。

選 GHCR 而不是 Docker Hub：image 直接掛在既有的 GitHub repo 底下，不用另外開 Docker Hub 帳號/組織去管理；公開 repo 用量免費，也沒有 Docker Hub 匿名 pull 常見的速率限制問題；套件的權限/可見度跟著 repo 設定走。

image tag 直接沿用推上去的 git tag 本身（例如 `v1.0`），另外固定推一份 `latest`；沒有另外解析成 semver，因為現有的 `v1.0` 這類 tag 本來就不是嚴格 semver 格式。

## Considered options

- **Docker Hub**：使用者最熟悉、docker-compose 預設 registry，但需要額外註冊/維護一個 Docker Hub 帳號或組織，且免費方案對匿名 pull 有速率限制，跟這台機器本身的自架風格（能少一個外部帳號就少一個）不符。
- **不做自動化，開發者手動 `docker build` + `docker push`**：最省事，但容易忘記在改完程式碼後重新推、或推的版本跟 git tag 對不上，長期會讓「image 版本」跟「程式碼版本」脫鉤。

## Consequences

- 第一次推送後要手動到 GitHub 該 repo 的 Packages 頁面把這個 package 的 visibility 設成 public（`GITHUB_TOKEN` 建立的套件預設 private），不然使用者會 pull 不到。
- image 只建置 `linux/amd64`：runtime base image `mcr.microsoft.com/playwright` 官方沒有發布其他平台的版本，之後若要支援 arm64 得先確認有沒有替代的 Playwright 基底可用。
- 之後每次要發新版 image，得記得打對應的 git tag（`v*`），不打 tag 就不會觸發，`main` 分支本身的 push 不會自動建置。
