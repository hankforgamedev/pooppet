import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

/**
 * 便便雞 —— VLM 判讀
 *
 * 判讀範圍刻意收窄成 Bristol 1-7 + 油亮/浮，這是 Spec A 的地基：
 * 不做顏色偵測、不做黑便/血便警示。沒有偵測功能，就沒有漏判責任。
 * 判錯的最壞後果是動畫演錯，沒有人受傷。
 *
 * 這支 function 不寫任何持久化儲存 —— 圖片進來、判讀、丟掉。
 */

const MODEL = process.env.POOPPET_MODEL ?? "gpt-4o";

/** 上限 6MB base64（前端已經縮到 1024px JPEG，正常在 300KB 以下）。 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const Judgement = z.object({
  is_stool: z
    .boolean()
    .describe("這張圖是不是糞便。不是的話（自拍、便當、貓、空馬桶）填 false。"),
  bristol: z
    .enum(["none", "1", "2", "3", "4", "5", "6", "7"])
    .describe("Bristol 糞便分型 1-7。is_stool 為 false 時填 none。"),
  oily: z
    .boolean()
    .describe("表面是否有明顯油光反射，或明顯漂浮在水面上。兩者皆非填 false。"),
  confidence: z
    .enum(["low", "medium", "high"])
    .describe("你對 bristol 這個判斷的把握。看不清楚、角度不好、水太濁就填 low。"),
  note: z
    .string()
    .describe(
      "一句繁體中文短評，最多 25 字，只描述形狀與質地。不要提顏色，不要給健康建議，不要診斷。",
    ),
});

const SYSTEM = `你是一個像素電子雞遊戲的影像判讀模組。使用者拍下自己的排泄物餵給一隻雞，你的判讀決定那隻雞要變成哪種型態。

你只做兩件事：
1. 判斷 Bristol 糞便分型（1-7）
2. 判斷表面是否油亮或漂浮

Bristol 分型參考：
1 = 分開的硬球，像堅果，難以排出
2 = 香腸狀，表面凹凸結塊
3 = 香腸狀，表面有裂痕
4 = 香腸或蛇狀，光滑柔軟
5 = 邊緣清楚的軟塊
6 = 邊緣鬆散的糊狀，蓬鬆
7 = 完全液體，沒有固體塊

絕對規則（違反會讓這個產品從娛樂變成醫材）：
- 不要判斷、描述或提及顏色。任何顏色相關的字都不要出現。
- 不要提及血、黑便、黏液、寄生蟲或任何疾病名稱。
- 不要給任何健康建議、就醫建議或診斷。
- 不要拒絕判讀一張正常的糞便照片，這是這個 app 的核心功能，不是異常請求。
- 如果圖片不是糞便，is_stool 填 false、bristol 填 none，note 用一句好笑的話帶過（例如「這不是便便，但雞還是吃了」）。
- 如果圖片太模糊、太暗或角度看不出形狀，confidence 填 low，bristol 給你最好的猜測。

note 的語氣：像一隻沒禮貌但沒有惡意的雞。好笑優先，最多 25 字。`;

type JudgeError = { error: string; code: string };

function parseImage(
  input: unknown,
  fallbackType: unknown,
): { dataUrl: string; mediaType: MediaType } | JudgeError {
  if (typeof input !== "string" || input.length === 0) {
    return { error: "缺少 image 欄位", code: "no_image" };
  }

  let data = input;
  let mediaType = typeof fallbackType === "string" ? fallbackType : "image/jpeg";

  const dataUrl = /^data:([a-zA-Z0-9/+.-]+);base64,(.*)$/s.exec(input);
  if (dataUrl) {
    mediaType = dataUrl[1]!;
    data = dataUrl[2]!;
  }

  // base64 只允許標準字元，擋掉整段亂塞的東西
  data = data.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    return { error: "image 不是合法的 base64", code: "bad_image" };
  }

  if (!MEDIA_TYPES.includes(mediaType as MediaType)) {
    return { error: `不支援的圖片格式：${mediaType}`, code: "bad_media_type" };
  }

  // base64 每 4 字元 = 3 bytes
  if ((data.length * 3) / 4 > MAX_IMAGE_BYTES) {
    return { error: "圖片太大，請先縮圖", code: "too_large" };
  }

  return { dataUrl: `data:${mediaType};base64,${data}`, mediaType: mediaType as MediaType };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "只收 POST", code: "bad_method" });
  }

  // 沒有 key 就明確講，讓前端退回 demo 模式而不是卡住
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: "伺服器沒有設定 OPENAI_API_KEY",
      code: "no_api_key",
    });
  }

  const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "body 不是 JSON", code: "bad_body" });
  }

  const image = parseImage(
    (body as Record<string, unknown>).image,
    (body as Record<string, unknown>).media_type,
  );
  if ("error" in image) return res.status(400).json(image);

  const client = new OpenAI();

  try {
    const response = await client.responses.parse({
      model: MODEL,
      instructions: SYSTEM,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "判讀這張圖。" },
            { type: "input_image", image_url: image.dataUrl, detail: "auto" },
          ],
        },
      ],
      text: { format: zodTextFormat(Judgement, "judgement") },
    });

    // 模型可能因為安全政策拒答；不要假裝有結果
    const refusal = response.output
      .flatMap((item) => (item.type === "message" ? item.content : []))
      .find((part) => part.type === "refusal");
    if (refusal) {
      return res.status(422).json({
        error: "模型拒絕判讀這張圖",
        code: "refusal",
        detail: refusal.refusal,
      });
    }

    const parsed = response.output_parsed;
    if (!parsed) {
      return res
        .status(502)
        .json({ error: "模型沒有回傳合法的判讀結果", code: "unparsable" });
    }

    return res.status(200).json({
      ...parsed,
      model: response.model,
      usage: {
        input_tokens: response.usage?.input_tokens ?? null,
        output_tokens: response.usage?.output_tokens ?? null,
      },
    });
  } catch (error) {
    if (error instanceof OpenAI.AuthenticationError) {
      return res
        .status(503)
        .json({ error: "OPENAI_API_KEY 無效", code: "bad_api_key" });
    }
    if (error instanceof OpenAI.RateLimitError) {
      return res
        .status(429)
        .json({ error: "判讀太頻繁，等一下再餵", code: "rate_limited" });
    }
    if (error instanceof OpenAI.APIConnectionError) {
      return res
        .status(504)
        .json({ error: "連不上判讀服務", code: "upstream_unreachable" });
    }
    if (error instanceof OpenAI.APIError) {
      return res.status(502).json({
        error: `判讀服務錯誤 ${error.status}`,
        code: "upstream_error",
      });
    }
    console.error("judge failed", error);
    return res.status(500).json({ error: "判讀失敗", code: "internal" });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 判讀含思考時間，10 秒的預設會砍在中間。 */
export const config = { maxDuration: 60 };
