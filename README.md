# 桌遊櫃（GitHub Actions 版）

網頁本身**完全不對外連線**。資料是由 GitHub Actions 在 GitHub 自己的伺服器上，定期抓 Google Sheet + BoardGameGeek，整理成 `data/games.json`，網頁只讀這個同源的靜態檔案。這樣可以完全避開瀏覽器 CORS 限制，以及任何本機網路/DNS 對第三方服務的封鎖問題。

## 檔案結構

```
index.html                       ← 網頁本體
config.json                      ← 填你的 Google Sheet CSV 網址
package.json                     ← Node 依賴（fast-xml-parser, he）
scripts/build-data.mjs           ← 抓資料、整理成 json 的腳本
data/games.json                  ← 產生出來的資料（一開始是空的佔位檔）
.github/workflows/update-data.yml ← 定期執行腳本的設定
```

上傳時請**保留這個資料夾結構**（`.github/workflows/`、`scripts/`、`data/` 都要是子資料夾，不能全部丟在同一層）。GitHub 網頁的「Add file → Upload files」支援直接把整個資料夾拖進去。

## 設定步驟

1. **改 `config.json`**：把 `csvUrl` 換成你自己 Google Sheet 發布成 CSV 的網址（`檔案 → 共用 → 發布到網路`，格式選 CSV）。
2. **開權限**：repo 的 `Settings → Actions → General → Workflow permissions`，選「Read and write permissions」並存檔（Action 需要這個權限才能把抓好的資料寫回 repo）。
3. **開 GitHub Pages**：`Settings → Pages`，Source 選 `Deploy from a branch`，Branch 選 `main`、資料夾選 `/ (root)`。
4. **手動跑第一次**：到 `Actions` 分頁，左側選 `Update board game data`，右邊按 `Run workflow`。等 1～2 分鐘跑完，`data/games.json` 就會被自動 commit 回 repo。
5. 打開你的 GitHub Pages 網址，應該就能看到資料了。之後每天 UTC 18:00（台灣時間凌晨 2 點）會自動重新抓一次，也可以隨時手動 `Run workflow` 更新。

## Google Sheet 欄位

第一列是欄位名稱，除了 `NAME`，其餘都可留空：

| 欄位 | 說明 |
|---|---|
| `BGGID` | BoardGameGeek 遊戲編號，填了會自動帶出圖片、人數、年齡、時間、出版商、類別、簡介、擴充列表。 |
| `NAME` | 顯示名稱（必填）。 |
| `PLAYER` / `AGE` / `PLAYTIME` / `PUBLISHER` / `GAMETYPE` | 手動填會覆蓋自動資料。`GAMETYPE` 請填「派對遊戲／陣營遊戲／策略遊戲／心機遊戲／卡牌遊戲／兒童遊戲／家庭遊戲」其中之一。 |
| `IMGUR` | 自訂圖片網址（任何圖床都可以），優先於 BGGID 抓到的圖。 |
| `OWN` | 你擁有的擴充，用頓號「、」分開填 BGGID 或名稱關鍵字。 |
| `NOTE` | 自訂備註。 |

儲存格內容請避免用半形逗號「,」，頓號「、」沒問題。

## 疑難排解

- **網頁一直顯示「讀不到 data/games.json」**：先確認 Actions 有沒有跑成功（Actions 分頁看有沒有綠勾勾），沒有的話點進去看錯誤訊息；也確認 `data/games.json` 這個檔案有沒有真的出現在你的 repo 裡。
- **Action 跑失敗，錯誤是權限不足（push 被拒絕）**：回頭檢查上面第 2 步的 Workflow permissions 有沒有設對。
- **某些 BGGID 查無資料**：畫面下方狀態列會顯示查無資料的數量，通常是 BGG 那次剛好回應不完整，重新手動 Run workflow 一次通常就會抓到。
