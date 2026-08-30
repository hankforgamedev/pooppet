/**
 * api/judge.ts 的輸入驗證與錯誤路徑。
 * 不打真的 API —— 這裡只驗「還沒送出去之前」的每一條分支。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { default: handler } = await import("../api/judge.ts");

function fakeRes() {
  const res = {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

const call = async (req) => {
  const res = fakeRes();
  await handler(req, res);
  return res;
};

const KEY = "OPENAI_API_KEY";
const withKey = async (fn) => {
  const prev = process.env[KEY];
  process.env[KEY] = "sk-test-not-real";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
};

test("GET 被擋掉", async () => {
  const res = await call({ method: "GET", body: {} });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
});

test("沒有 API key → 503，讓前端退回 demo 模式", async () => {
  const prev = process.env[KEY];
  delete process.env[KEY];
  try {
    const res = await call({ method: "POST", body: { image: "abc" } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, "no_api_key");
  } finally {
    if (prev !== undefined) process.env[KEY] = prev;
  }
});

test("body 不是物件 → 400", async () => {
  await withKey(async () => {
    const res = await call({ method: "POST", body: "not json at all" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "bad_body");
  });
});

test("沒有 image 欄位 → 400", async () => {
  await withKey(async () => {
    const res = await call({ method: "POST", body: {} });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "no_image");
  });
});

test("image 不是 base64 → 400", async () => {
  await withKey(async () => {
    const res = await call({ method: "POST", body: { image: "data:image/png;base64,$$$$" } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "bad_image");
  });
});

test("不支援的格式 → 400", async () => {
  await withKey(async () => {
    const res = await call({
      method: "POST",
      body: { image: "data:image/svg+xml;base64,AAAA" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "bad_media_type");
  });
});

test("圖片太大 → 400，不浪費一次判讀", async () => {
  await withKey(async () => {
    const huge = "A".repeat(9 * 1024 * 1024);
    const res = await call({ method: "POST", body: { image: `data:image/jpeg;base64,${huge}` } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "too_large");
  });
});

test("字串 body 會被 parse", async () => {
  await withKey(async () => {
    const res = await call({ method: "POST", body: JSON.stringify({ image: "" }) });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "no_image");
  });
});

test("合法的 data URL 通過驗證，並走到上游呼叫", async () => {
  await withKey(async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const res = await call({ method: "POST", body: { image: `data:image/png;base64,${png}` } });
    // 輸入驗證過了才會走到這裡。實際回什麼取決於這台機器連不連得到 OpenAI
    // （CI sandbox 連不到，會是 upstream_error），重點是「不是輸入錯誤」。
    const upstream = ["bad_api_key", "rate_limited", "upstream_unreachable", "upstream_error",
                      "refusal", "unparsable", "internal"];
    assert.ok(
      upstream.includes(res.body.code),
      `預期上游錯誤，實際拿到 ${res.statusCode} ${res.body.code}`,
    );
    assert.notEqual(res.statusCode, 400, "不應該是輸入驗證錯誤");
  });
});
