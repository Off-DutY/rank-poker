# 排名撲克（Rank Poker）

3–13 人的合作式網頁遊戲。玩家依德州撲克牌力估計自己的順位，全隊排對順序才過關。
完整規則與設計見 [docs/SPEC.md](docs/SPEC.md)。

## 架構

- 靜態網站（Vite + TypeScript），沒有自建伺服器。
- 玩家之間用 WebRTC P2P 連線。`trystero` 透過公共 Nostr relay 交換連線資訊。
- 房主的瀏覽器負責發牌、計時和所有判定。

| 目錄 | 內容 |
|---|---|
| `src/core` | 牌、牌力計算、衝突排序、狀態機。不依賴瀏覽器。 |
| `src/net` | 訊息協定、房主端與玩家端、傳輸層（Trystero 與測試用的記憶體版）。 |
| `src/ui` | 畫面。 |

## 指令

| 指令 | 用途 |
|---|---|
| `npm install` | 安裝套件 |
| `npm run dev` | 啟動開發伺服器 |
| `npm test` | 執行單元測試與整合測試 |
| `npm run build` | 型別檢查並建置到 `dist/` |

## 本機多人測試

1. 執行 `npm run dev`。
2. 在 1 個分頁建立房間。
3. 把網址（含 `#房號`）貼到其他分頁。每個分頁是不同的玩家。

注意：複製分頁會連 sessionStorage 一起複製，2 個分頁會變成同 1 位玩家。請開新分頁再貼上網址。

## 部署

`npm run build` 後，把 `dist/` 上傳到任何靜態主機（GitHub Pages、Netlify、Cloudflare Pages）。
建置使用相對路徑（`base: './'`），可以放在子目錄。

## 已知限制

- 房主可以用 DevTools 看到所有手牌（規格第 11 節）。
- 房主重新整理或斷線，遊戲就結束（規格第 10 節）。
- 沒有 TURN relay：部分公司或行動網路無法建立 P2P 連線。
