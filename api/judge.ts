/**
 * Pooppet image judgement endpoint for Vercel.
 *
 * Product boundary (from docs/spec-a-product.md):
 * - classify Bristol 1-7
 * - detect only oily / floating appearance
 * - never inspect colour or produce medical advice
 * - never persist the uploaded image
 */

type VercelLikeRequest = {
  method?: string;
  body?: unknown;
};

type VercelLikeResponse = {
  setHeader(name: string, value: string): VercelLikeResponse;
  status(code: number): VercelLikeResponse;
  json(payload: unknown): VercelLikeResponse;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type MediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
type Bristol = "none" | "1" | "2" | "3" | "4" | "5" | "6" | "7";
type Confidence = "low" | "medium" | "high";
type PetSignal = "stone" | "oily" | "perfect" | "watery";

type Judgement = {
  is_stool: boolean;
  bristol: Bristol;
  oily: boolean;
  confidence: Confidence;
  note: string;
};

type JudgeError = { error: string; code: string };

const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.6-terra";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 25_000;
const MEDIA_TYPES = new Set<MediaType>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const BRISTOL_VALUES: Bristol[] = ["none", "1", "2", "3", "4", "5", "6", "7"];
const CONFIDENCE_VALUES: Confidence[] = ["low", "medium", "high"];

const JUDGEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    is_stool: {
      type: "boolean",
      description: "Whether the image clearly contains human stool.",
    },
    bristol: {
      type: "string",
      enum: BRISTOL_VALUES,
      description: "Bristol stool type 1-7, or none when is_stool is false.",
    },
    oily: {
      type: "boolean",
      description: "Whether the surface is visibly oily or the stool is clearly floating.",
    },
    confidence: {
      type: "string",
      enum: CONFIDENCE_VALUES,
      description: "Confidence in the Bristol classification.",
    },
    note: {
      type: "string",
      maxLength: 25,
      description: "A short Traditional Chinese joke about shape or texture only.",
    },
  },
  required: ["is_stool", "bristol", "oily", "confidence", "note"],
} as const;

const SYSTEM = `你是排泄物電子雞 Pooppet 的影像分類模組，不是醫療系統。

你只做兩件事：
1. 依外觀判斷 Bristol 糞便分型 1–7
2. 判斷表面是否明顯油亮或明顯漂浮

Bristol 分型：
1 = 分開的硬球
2 = 香腸狀、表面凹凸結塊
3 = 香腸狀、表面有裂痕
4 = 香腸或蛇狀、光滑柔軟
5 = 邊緣清楚的軟塊
6 = 邊緣鬆散的糊狀
7 = 完全液體、沒有固體塊

產品不可跨越的規則：
- 不判斷、描述或暗示任何顏色。
- 不提血、黑便、黏液、寄生蟲、疾病、健康、診斷或就醫。
- 不提供飲食、治療或健康建議。
- 圖片不是糞便時，is_stool=false、bristol=none、oily=false。
- 圖片模糊、太暗或角度不佳時，confidence=low，但仍給最佳 Bristol 猜測。
- note 只描述形狀或質地，使用繁體中文，像一隻沒禮貌但沒有惡意的雞，最多 25 字。`;

const BANNED_NOTE =
  /顏色|紅|黑|白|灰|黃|綠|藍|紫|血|黏液|寄生蟲|疾病|癌|感染|健康|就醫|醫生|醫師|診斷|治療|飲食/u;

export function signalsFor(judgement: Judgement): PetSignal[] {
  if (!judgement.is_stool) return [];

  const signals: PetSignal[] = [];
  if (judgement.oily) signals.push("oily");
  if (judgement.bristol === "1" || judgement.bristol === "2") {
    signals.push("stone");
  } else if (judgement.bristol === "4") {
    signals.push("perfect");
  } else if (judgement.bristol === "6" || judgement.bristol === "7") {
    signals.push("watery");
  }
  return signals;
}

function parseImage(input: unknown, fallbackType: unknown): { dataUrl: string } | JudgeError {
  if (typeof input !== "string" || input.length === 0) {
    return { error: "缺少 image 欄位", code: "no_image" };
  }

  let data = input;
  let mediaType = typeof fallbackType === "string" ? fallbackType : "image/jpeg";
  const dataUrlMatch = /^data:([a-zA-Z0-9/+.-]+);base64,(.*)$/s.exec(input);
  if (dataUrlMatch) {
    mediaType = dataUrlMatch[1]!;
    data = dataUrlMatch[2]!;
  }

  data = data.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    return { error: "image 不是合法的 base64", code: "bad_image" };
  }
  if (!MEDIA_TYPES.has(mediaType as MediaType)) {
    return { error: `不支援的圖片格式：${mediaType}`, code: "bad_media_type" };
  }

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const byteLength = Math.floor((data.length * 3) / 4) - padding;
  if (byteLength > MAX_IMAGE_BYTES) {
    return { error: "圖片太大，請先縮圖", code: "too_large" };
  }

  return { dataUrl: `data:${mediaType};base64,${data}` };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseJudgement(value: unknown): Judgement | null {
  if (!value || typeof value !== "object") return null;
  const j = value as Record<string, unknown>;
  if (typeof j.is_stool !== "boolean") return null;
  if (!BRISTOL_VALUES.includes(j.bristol as Bristol)) return null;
  if (typeof j.oily !== "boolean") return null;
  if (!CONFIDENCE_VALUES.includes(j.confidence as Confidence)) return null;
  if (typeof j.note !== "string" || j.note.length > 25) return null;
  if (j.is_stool && j.bristol === "none") return null;
  if (!j.is_stool && (j.bristol !== "none" || j.oily !== false)) return null;

  return {
    is_stool: j.is_stool,
    bristol: j.bristol as Bristol,
    oily: j.oily,
    confidence: j.confidence as Confidence,
    note: BANNED_NOTE.test(j.note) ? "雞只盯著形狀看了很久。" : j.note,
  };
}

function outputPayload(response: unknown): { parsed?: Judgement; refusal?: string } {
  if (!response || typeof response !== "object") return {};
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return {};

  for (const item of output) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if ((part as { type?: unknown }).type === "refusal") {
        return { refusal: String((part as { refusal?: unknown }).refusal ?? "refused") };
      }
      if ((part as { type?: unknown }).type === "output_text") {
        const parsed = parseJudgement(safeJson(String((part as { text?: unknown }).text ?? "")));
        if (parsed) return { parsed };
      }
    }
  }
  return {};
}

export function createHandler(fetchImpl: FetchLike = fetch) {
  return async function handler(req: VercelLikeRequest, res: VercelLikeResponse) {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "只收 POST", code: "bad_method" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const model = process.env.POOPPET_MODEL ?? DEFAULT_MODEL;

    try {
      const upstream = await fetchImpl(OPENAI_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          store: false,
          instructions: SYSTEM,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "依規格判讀這張圖。" },
                { type: "input_image", image_url: image.dataUrl, detail: "high" },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "pooppet_judgement",
              strict: true,
              schema: JUDGEMENT_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });

      const responseBody = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        const code = upstream.status === 401
          ? "bad_api_key"
          : upstream.status === 429
            ? "rate_limited"
            : "upstream_error";
        const status = upstream.status === 429 ? 429 : upstream.status === 401 ? 503 : 502;
        return res.status(status).json({ error: "判讀服務暫時無法使用", code });
      }

      const output = outputPayload(responseBody);
      if (output.refusal) {
        return res.status(422).json({ error: "模型拒絕判讀這張圖", code: "refusal" });
      }
      if (!output.parsed) {
        return res.status(502).json({
          error: "模型沒有回傳合法的判讀結果",
          code: "unparsable",
        });
      }

      const responseRecord = responseBody as Record<string, unknown>;
      const usage = responseRecord.usage && typeof responseRecord.usage === "object"
        ? responseRecord.usage as Record<string, unknown>
        : {};
      return res.status(200).json({
        ...output.parsed,
        signals: signalsFor(output.parsed),
        analyzed_at: new Date().toISOString(),
        model: typeof responseRecord.model === "string" ? responseRecord.model : model,
        usage: {
          input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
          output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return res.status(504).json({ error: "判讀逾時", code: "upstream_timeout" });
      }
      console.error("judge failed", error);
      return res.status(502).json({ error: "連不上判讀服務", code: "upstream_unreachable" });
    } finally {
      clearTimeout(timeout);
    }
  };
}

export default createHandler();

export const config = { maxDuration: 60 };

