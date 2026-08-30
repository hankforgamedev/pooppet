# 便便雞 🐔

拍你的便便 → 餵給一隻像素雞 → 雞會變成對應的形態。

好笑優先的排泄物電子雞。健康資訊是佐料，不是賣點。

## 這個 repo 有什麼

```text
index.html            整個 app（單一檔案、零建置、可加到主畫面的 PWA）
api/judge.ts          VLM 判讀（Vercel serverless，可選）
docs/spec-a-product.md  Spec A — 完整版產品方向
docs/spec-b-demo.md     Spec B — 2.5 小時 demo
docs/ai-judgment.md     AI 判讀怎麼接的、累積制怎麼算、失敗怎麼退
docs/poop-mechanic.md   牠自己大便、清理倒數、以及為什麼只在前景跑
test/                 19 個瀏覽器測試 + 9 個 handler 測試
```

## 三分鐘上線

**只要 demo（判讀是假的，不需要任何 key）**

把 `index.html` 拖進 [vercel.com/new](https://vercel.com/new) 或 netlify drop，
拿網址，手機 Safari 開 → 分享 → 加入主畫面。全螢幕，看起來就是 app。

**要真的 AI 判讀**

```bash
npm install
cp .env.example .env      # 填 OPENAI_API_KEY
npx vercel dev
```

部署到 Vercel 之後，在 Project Settings → Environment Variables 設 `OPENAI_API_KEY`，
然後在 app 裡按 ⚙ → 判讀來源 → 把「AI 判讀」打開。

## 預設是 demo 模式

**AI 判讀預設是關的。** 這是刻意的 —— Spec B 要的是現場零意外。

- ⚙ 可以指定下一次餵食要觸發哪一種變形，一次生效，完全不打 API
- 打開 AI 判讀之後才會真的送圖給模型，連不上就退回隨機，雞不會卡住

demo 動線照 [Spec B](./docs/spec-b-demo.md) 走 90 秒。

## 牠自己也會大便

每餵 4 次，牠會自己大一坨 —— **比你餵牠的那坨小很多**，大小差距就是笑點。

30 秒內點它清掉，不然牠會自己吃掉。這個倒數**只算你真的在看螢幕的時間**，
切到背景就凍結 —— 沒看到的過程等於沒發生。詳見 [poop-mechanic.md](./docs/poop-mechanic.md)。

## 判讀範圍（刻意收窄）

只判 **Bristol 1–7 + 油亮／浮**。**不做顏色偵測、不做黑便警示。**

黑便／血便靠開場衛教 + ⚙ 裡的常駐「安全須知」頁處理。
沒有偵測功能，就沒有漏判責任 —— 這是產品地基，不是待辦事項。詳見 [Spec A](./docs/spec-a-product.md)。

這是娛樂與生活紀錄用途，不是醫療器材。

## 開發

```bash
npm run typecheck   # api/judge.ts 型別檢查
npm test            # handler 測試 + 瀏覽器測試（會開一顆 Chromium）
```

瀏覽器測試預設用 `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`，
本機跑的話設 `CHROMIUM_PATH` 指到你自己的 Chromium。

## 自訂雞的圖

`index.html` 內建一隻 16×16 像素雞。想換成自己畫的：

1. 在 pixie.haus 生一隻雞的 walk cycle，匯出橫向排列、透明背景的 spritesheet
2. 存成 `chick.png` 放跟 `index.html` 同一層
3. 改 `ART.frames` 成你的格數

圖沒放也不會壞，會自動退回內建像素雞。
