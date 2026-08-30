# Pooppet 拍照判讀功能規格

> 這是 Pooppet App 內的功能模組，不是 Codex plugin。

## 一句話

使用者拍照餵雞；Vercel 後端只判 Bristol 1–7 與油亮／浮，回傳遊戲訊號；照片與紀錄只保留在使用者裝置。

## 產品邊界

- 定位：娛樂／生活紀錄，不是健康診斷。
- AI 可以判：是不是糞便、Bristol 1–7、是否油亮／浮。
- AI 不可以判：顏色、血便、黑便、疾病、健康程度或是否需要就醫。
- `spicy` 只能由使用者手動標記，AI 不得推測。
- 判讀失敗不阻塞餵雞動畫；前端依既有規格退回 demo 結果並清楚標示。

## 資料流

```text
手機拍照
  → 前端縮成最長邊 1024px、JPEG q0.82
  → POST /api/judge
  → Vercel Function 呼叫 OpenAI Responses API
  → 固定 JSON 回傳
  → 前端加入 spicy 標籤並更新最近三次訊號
  → 最近三次至少兩次同訊號才改變電子雞型態
  → 縮圖與結果寫入裝置 IndexedDB
```

## 狀態與訊號（沿用既有 Spec A）

| 判讀／輸入 | 訊號 | 電子雞型態 |
|---|---|---|
| Bristol 1–2 | `stone` | 石化 |
| `oily=true` | `oily` | 油亮 |
| 使用者自填辣 | `spicy` | 噴火 |
| Bristol 4 | `perfect` | 完美 |
| Bristol 6–7 | `watery` | 液化 |
| Bristol 3、5 | 無 | 還行／不變形 |

同一筆可同時有多個訊號。優先序仍是：
`stone > watery > oily > spicy > perfect`。

## 後端 API

### `POST /api/judge`

Request：

```json
{
  "image": "data:image/jpeg;base64,..."
}
```

限制：

- 接受 JPEG、PNG、WEBP、非動畫 GIF。
- 前端目標大小為 1024px JPEG；後端硬上限 4 MB。
- API key 只存在 Vercel Environment Variables。
- 使用 `gpt-5.6-terra`，可用 `POOPPET_MODEL` 覆寫。
- 使用 Structured Outputs、`detail: high`、`store: false`。
- Function 不寫檔案、資料庫、Blob storage 或 log 圖片內容。

成功回傳：

```json
{
  "is_stool": true,
  "bristol": "6",
  "oily": false,
  "confidence": "medium",
  "note": "這坨已經放棄維持隊形",
  "signals": ["watery"],
  "analyzed_at": "2026-08-30T12:34:56.000Z",
  "model": "gpt-5.6-terra",
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 80
  }
}
```

錯誤 `code`：

- `bad_method`
- `no_api_key` / `bad_api_key`
- `bad_body` / `no_image` / `bad_image` / `bad_media_type` / `too_large`
- `rate_limited`
- `refusal` / `unparsable`
- `upstream_timeout` / `upstream_unreachable` / `upstream_error`

## 使用者裝置上的照片紀錄

照片不能放進 `localStorage`；使用 IndexedDB 儲存縮圖 Blob 與 metadata。

Object store：`feedPhotos`，key：`id`。

```ts
type LocalFeedPhoto = {
  id: string;
  image_blob: Blob;
  captured_at: string;       // 裝置產生的 UTC ISO timestamp
  timezone_offset: number;   // 拍攝當下的分鐘偏移
  analyzed_at: string | null;
  is_stool: boolean | null;
  bristol: "none" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | null;
  oily: boolean | null;
  spicy: boolean;
  confidence: "low" | "medium" | "high" | null;
  note: string;
  signals: Array<"stone" | "oily" | "spicy" | "perfect" | "watery">;
  pet_state_after: "normal" | "stone" | "oily" | "spicy" | "perfect" | "watery" | null;
  analysis_status: "pending" | "success" | "fallback" | "demo" | "forced";
};
```

規則：

- 拍照後立即建立 `pending` 紀錄；判讀完成再更新同一筆。
- 即使判讀失敗，照片、日期、時間與 `fallback` 狀態仍保留。
- 支援單筆刪除與「清除所有本機照片」。
- 不同步雲端、不跨裝置、不備份到 Vercel。
- 清除網站資料或移除 PWA 可能一併清除 IndexedDB，UI 必須告知使用者。

## 驗收條件

1. 真 AI 模式下，清楚糞便照片會得到合法 Bristol 值及固定欄位。
2. Bristol／油亮到遊戲訊號的映射完全符合 Spec A。
3. `spicy` 不出現在 AI schema，只能由使用者本機加入。
4. 後端 request 明確包含 `store: false`，且 response 禁止快取。
5. 模型若輸出顏色或醫療字眼，後端不把該文字交給前端。
6. API key、原圖與 base64 不出現在前端 bundle、回應或伺服器 log。
7. 照片與拍攝日期／時間在重新開啟 PWA 後仍可於本機查看。
8. API 逾時、限流或拒答時，雞不會卡在餵食動畫。

## Vercel 上線條件

Vercel Project Environment Variables：

```text
OPENAI_API_KEY=（secret）
POOPPET_MODEL=gpt-5.6-terra
```

部署後最小 smoke test：

1. `GET /api/judge` 回 `405`。
2. 不帶圖片的 `POST /api/judge` 回 `400 no_image`。
3. 真實圖片回 `200`，且 `signals`、Bristol 與 usage 欄位存在。
4. Vercel logs 不包含 request body 或圖片 base64。

