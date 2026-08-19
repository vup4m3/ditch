---
status: accepted
---

# 轉檔使用獨立的 Transcode Concurrency Limit，不併入既有的 Concurrency Limit

既有 Concurrency Limit（ADR-0009）限制的是「同時能有幾個 Download Job 佔用下載名額」，背後瓶頸主要是 headless Chromium／網路資源。轉檔（ADR-0012 新增的 ffmpeg 步驟）吃的是完全不同的資源——CPU，而且 AV1 軟體編碼會長時間佔滿多核心。如果併入同一個名額池，下載與轉檔會互搶名額，兩種行為就沒辦法個別調校，也容易讓轉檔工作拖垮下載（或反過來）。因此新增一個獨立設定 Transcode Concurrency Limit，管理獨立的 `transcodeQueued`／`transcoding` 名額池，預設值 1（保守起見，避免預設就讓 CPU 被榨乾）；一個 Download Job 因此可能依序經過兩個完全獨立的等待佇列（Queue 等下載名額、Transcode Queue 等轉檔名額，見 CONTEXT.md）。

## Considered options

- 併入既有 Concurrency Limit：實作最省事，但下載與轉檔資源性質不同，混用名額池會讓兩者互相卡住，且使用者沒辦法針對兩種不同瓶頸分別調整。
