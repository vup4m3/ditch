---
status: accepted
---

# 下載與解密使用純 JS/Node 實作，不依賴 ffmpeg

原專案完全沒有使用 ffmpeg，而是用純 JS 抓取 segment、瀏覽器原生 WebCrypto 解密 AES-128、直接位元組串接輸出。我們在 Node 版本比照同樣做法（用 Node `crypto` 取代 WebCrypto），維持零額外二進位依賴、行為貼近原專案；輸出格式的合法性則靠「正確處理 HLS `.ts` / DASH fMP4 的串接規則」達成，不需要額外的 remux 邏輯或函式庫。

## Considered options

改用 ffmpeg 處理下載與封裝，格式相容性更廣，但會引入額外二進位依賴、偏離原專案邏輯。
