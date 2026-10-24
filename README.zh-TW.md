# video-transcribe

用 Google Gemini 把影片變成**帶時間戳的逐字稿**。支援 **YouTube 網址**（不下載影片）與**本機檔案**（mp4、mov、webm、mkv、mp3、wav 等）。

輸出是 Markdown：每段前面有 `[HH:MM:SS]` 時間戳，語言照影片原本的口語，最後附幾點摘要。本機影片還可以用**場景偵測**另存關鍵畫面。單一檔案、沒有 npm 套件相依（用 Node 內建的 `https`）。

> **請先看隱私：** 本機檔案會**整個上傳到 Google**；使用免費層時，Google 可能讓人工審閱你送出的內容與輸出。機密或個人資料請不要用這個工具，細節見下方「隱私」一節。
>
> **維護方式：** 本專案為盡力而為（best-effort）維護。歡迎回報問題與提 pull request，但不保證回應時間，也不保證支援任何特定的 Gemini 模型。
>
> English: [README.md](README.md)

## 安裝

需要 **Node.js 18 以上**，不必 `npm install`。

```bash
git clone https://github.com/tianjige-lab/video-transcribe.git
cd video-transcribe
```

到 <https://aistudio.google.com/apikey> 申請 Gemini API 金鑰，然後：

```bash
export GEMINI_API_KEY="你的金鑰"      # Windows PowerShell：$env:GEMINI_API_KEY="你的金鑰"
```

## 用法

```bash
# YouTube（直接交給 Gemini，只支援公開影片）
node video-transcribe.js "https://www.youtube.com/watch?v=VIDEO_ID"

# 本機檔案（透過 Gemini Files API 上傳；有裝 ffmpeg 就會一併產生關鍵畫面）
node video-transcribe.js "./talk.mp4"
```

### 選項

| 選項 | 預設 | 說明 |
|------|------|------|
| `--out <檔案>` | `./<名稱>-transcript.md` | 輸出路徑。YouTube 輸入的預設檔名是 `yt-<影片 id>-transcript.md`（id 只保留英數字、`_`、`-`）。 |
| `--force` | 關 | 覆蓋已存在的輸出檔或關鍵畫面資料夾。沒帶時，腳本會在**上傳與呼叫 API 之前**就停下。 |
| `--model <id>` | `gemini-3.8-flash` | Gemini 模型。也可以設環境變數 `GEMINI_VIDEO_MODEL`；`--model` 優先。 |
| `--max <tokens>` | `32768` | `maxOutputTokens`，長影片請調高。 |
| `--key-file <路徑>` | 無 | 從檔案讀金鑰，不用 `GEMINI_API_KEY`（一行一把，可用 `#` 註解）。 |
| `--thinking-level <等級>` | 不送出 | 選用：`minimal`、`low`、`medium`、`high`，會以 `generationConfig.thinkingConfig.thinkingLevel` 送出。不是每個模型都接受每個等級，例如 `gemini-3.8-flash` 會拒絕 `minimal`（見 [Google 的思考設定頁](https://ai.google.dev/gemini-api/docs/thinking)）；被拒時錯誤訊息會提示回到這個選項。 |
| `--scene [門檻]` | `0.4` | 場景偵測關鍵畫面（只限本機檔，需要 **ffmpeg**）。門檻介於 0 到 1：調高畫面變少，調低能抓到更細微的變化。 |
| `--frames-max <n>` | `40` | 關鍵畫面張數上限。 |
| `--no-frames` | 關 | 完全不抽關鍵畫面。 |
| `--keep-upload` | 關 | 把上傳的檔案留在 Google 那邊。預設在執行結束時（失敗也一樣）就刪除。 |

### 場景偵測與 ffmpeg

處理本機影片時，腳本會用 `ffmpeg` 的 `scene` 濾鏡，在每個場景切換點存一張 PNG 到 `<名稱>-frames/`，逐字稿最後會多一段「Key frames」，列出每張圖與時間戳。

- 這一段**需要 ffmpeg**：<https://ffmpeg.org/download.html>（或用你的套件管理員安裝）。
- 沒有帶 `--scene`、而且沒裝 ffmpeg：逐字稿照常產生，只會印一行說明「略過關鍵畫面」。
- 有明確帶 `--scene`、而且沒裝 ffmpeg：腳本會在**上傳與呼叫 API 之前**就停下，印出清楚的錯誤並以結束碼 2 結束。
- 腳本先用 `-fps_mode vfr`，只有在 ffmpeg 版本不認得這個選項時才退回舊的 `-vsync vfr`。
- 抽關鍵畫面不會改動逐字稿內容；ffmpeg 失敗時逐字稿照樣寫出。

## 選擇模型

預設是 `gemini-3.8-flash`。整理這個版本時（2026-10-24），Google 的模型清單把它列為正式版（GA）並建議新專案使用；棄用頁則把舊的 `gemini-2.5-flash` 列為舊版（只開放給過去用過的使用者），`gemini-2.0-flash` 已關閉。模型的供應常常變動，請在依賴某個模型之前先查 Google 的官方頁面：

- 模型清單：<https://ai.google.dev/gemini-api/docs/models>
- 棄用與關閉日期：<https://ai.google.dev/gemini-api/docs/deprecations>
- 思考設定：<https://ai.google.dev/gemini-api/docs/thinking>

要換模型，用 `--model`：

```bash
node video-transcribe.js "./talk.mp4" --model gemini-3.5-flash-lite     # 較省、較輕
GEMINI_VIDEO_MODEL=gemini-3.6-flash node video-transcribe.js "./talk.mp4"
```

舊版固定送 `thinkingBudget: 0`，那是 2.5 世代的設定；新版預設不送任何思考設定，需要時才用 `--thinking-level`。

## 隱私

- **本機檔案會離開你的電腦。** 整個檔案會透過 Gemini Files API 上傳到 Google 的伺服器。Google 會保存上傳的檔案 48 小時後自動刪除；本工具在執行結束時就會把它刪掉（加 `--keep-upload` 才保留）。見 <https://ai.google.dev/gemini-api/docs/files>。
- **YouTube 網址是交給 Google 的**，影片由 Google 自己去取。
- **免費層：你送出的內容與輸出可能被人工審閱。** 依 Gemini API 條款，免費層送出的內容可能被用來改進 Google 的產品，並可能由人工審閱；條款要求不要在那裡提交敏感、機密或個人資料。付費使用的規定不同。請在決定之前讀一次現行條款：<https://ai.google.dev/gemini-api/terms>。
- **不要送敏感內容**：私人會議錄音、醫療、法律或財務資料、他人的個人資料，或任何你無權交給第三方的內容。
- 逐字稿與關鍵畫面只會寫在你自己的磁碟上。本工具沒有遙測，除了 `generativelanguage.googleapis.com` 之外不會送資料到任何地方。

## 現況與限制

- **2026-10-24 以免費層、`gemini-3.8-flash` 實測過一次**：一支公開 YouTube 影片、一個小型本機檔（上傳、逐字稿、上傳檔自動刪除），以及一個本機檔加 `--scene`。Google 的 API 常變動，模型也可能回暫時性的「需求量大」錯誤，遇到時稍等再執行。離線測試（見下）涵蓋參數解析、輸出檔名、ffmpeg 處理與關鍵畫面抽取。
- API 金鑰放在 `x-goog-api-key` 標頭（同 Google 官方範例），不放在網址裡。
- 本機檔案會整個讀進記憶體再上傳，很大的檔案需要足夠的記憶體。
- Google 把這裡使用的 `generateContent` 標為「舊版（legacy）」，並建議新專案改用較新的 Interactions API，同時聲明 `generateContent` 仍受完整支援（<https://ai.google.dev/gemini-api/docs/interactions>）。本工具繼續使用 `generateContent`。
- **費用：** 每次執行都是一次 Gemini API 呼叫，依 Google 的價格計費。請手動執行；沒有設花費上限時不要放進無人看管的迴圈。
- YouTube 輸入：只支援公開影片；免費額度另有 Google 規定的每日限制。
- 看到 `Warning: hit maxOutputTokens` 時，請調高 `--max` 或把影片切開。
- 腳本不會儲存你的金鑰，只在執行時從環境變數或 `--key-file` 讀取。

## 測試

```bash
npm test        # 等同 node --test
```

測試全部離線執行、不需要 API 金鑰。有裝 ffmpeg 時，還會對內附的 `test-fixtures/scene-test.mp4`（用 ffmpeg 產生的 9 秒、320x240 測試圖樣）實跑一次場景偵測；沒裝就略過那一項。

## 授權

MIT，見 `LICENSE`。Tianjige Lab 維護。
