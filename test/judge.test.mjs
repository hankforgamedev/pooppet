import { test } from "node:test";
import assert from "node:assert/strict";

const { createHandler, signalsFor } = await import("../api/judge.ts");

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
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
}

async function call(handler, request) {
  const response = fakeRes();
  await handler(request, response);
  return response;
}

function openAIResponse(judgement) {
  return new Response(JSON.stringify({
    model: "gpt-5.6-terra-2026-08-01",
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(judgement) }],
    }],
    usage: { input_tokens: 1200, output_tokens: 80 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const validRequest = {
  method: "POST",
  body: { image: `data:image/png;base64,${PNG}` },
};

const KEY = "OPENAI_API_KEY";
const previousKey = process.env[KEY];
process.env[KEY] = "sk-test-not-real";
test.after(() => {
  if (previousKey === undefined) delete process.env[KEY];
  else process.env[KEY] = previousKey;
});

test("only accepts POST and disables caching", async () => {
  const response = await call(createHandler(), { method: "GET", body: {} });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, "POST");
  assert.equal(response.headers["Cache-Control"], "no-store, max-age=0");
});

test("returns 503 when the server API key is missing", async () => {
  const saved = process.env[KEY];
  delete process.env[KEY];
  try {
    const response = await call(createHandler(), validRequest);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, "no_api_key");
  } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  }
});

test("rejects malformed JSON bodies", async () => {
  const response = await call(createHandler(), { method: "POST", body: "not json" });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "bad_body");
});

test("validates missing and malformed image input before upstream", async () => {
  let calls = 0;
  const handler = createHandler(async () => {
    calls++;
    throw new Error("must not be called");
  });

  const missing = await call(handler, { method: "POST", body: {} });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.code, "no_image");

  const malformed = await call(handler, {
    method: "POST",
    body: { image: "data:image/png;base64,$$$$" },
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.code, "bad_image");
  assert.equal(calls, 0);
});

test("rejects unsupported media types and oversized images before upstream", async () => {
  let calls = 0;
  const handler = createHandler(async () => {
    calls++;
    throw new Error("must not be called");
  });

  const unsupported = await call(handler, {
    method: "POST",
    body: { image: "data:image/svg+xml;base64,AAAA" },
  });
  assert.equal(unsupported.body.code, "bad_media_type");

  const huge = "A".repeat(6 * 1024 * 1024);
  const oversized = await call(handler, {
    method: "POST",
    body: { image: `data:image/jpeg;base64,${huge}` },
  });
  assert.equal(oversized.body.code, "too_large");
  assert.equal(calls, 0);
});

test("calls Responses API with privacy and fixed-output controls", async () => {
  let requestBody;
  let auth;
  const handler = createHandler(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    auth = init.headers.authorization;
    return openAIResponse({
      is_stool: true,
      bristol: "1",
      oily: true,
      confidence: "high",
      note: "硬得像一袋彈珠",
    });
  });

  const response = await call(handler, validRequest);
  assert.equal(response.statusCode, 200);
  assert.equal(auth, "Bearer sk-test-not-real");
  assert.equal(requestBody.model, "gpt-5.6-terra");
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.input[0].content[1].detail, "high");
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(requestBody.text.format.strict, true);
  assert.deepEqual(response.body.signals, ["oily", "stone"]);
  assert.equal(response.body.bristol, "1");
  assert.equal(response.body.usage.input_tokens, 1200);
});

test("Bristol mapping follows the repository spec", () => {
  const base = { is_stool: true, oily: false, confidence: "high", note: "ok" };
  assert.deepEqual(signalsFor({ ...base, bristol: "1" }), ["stone"]);
  assert.deepEqual(signalsFor({ ...base, bristol: "2" }), ["stone"]);
  assert.deepEqual(signalsFor({ ...base, bristol: "3" }), []);
  assert.deepEqual(signalsFor({ ...base, bristol: "4" }), ["perfect"]);
  assert.deepEqual(signalsFor({ ...base, bristol: "5" }), []);
  assert.deepEqual(signalsFor({ ...base, bristol: "6" }), ["watery"]);
  assert.deepEqual(signalsFor({ ...base, bristol: "7" }), ["watery"]);
});

test("non-stool response cannot create a pet signal", async () => {
  const handler = createHandler(async () => openAIResponse({
    is_stool: false,
    bristol: "none",
    oily: false,
    confidence: "high",
    note: "這不是便便，雞照吃",
  }));
  const response = await call(handler, validRequest);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.signals, []);
});

test("rejects inconsistent structured output", async () => {
  const handler = createHandler(async () => openAIResponse({
    is_stool: false,
    bristol: "4",
    oily: false,
    confidence: "high",
    note: "wrong",
  }));
  const response = await call(handler, validRequest);
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, "unparsable");
});

test("removes forbidden medical or colour language from note", async () => {
  const handler = createHandler(async () => openAIResponse({
    is_stool: true,
    bristol: "4",
    oily: false,
    confidence: "high",
    note: "黑色請立刻就醫",
  }));
  const response = await call(handler, validRequest);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.note, "雞只盯著形狀看了很久。");
});

test("maps upstream auth, rate-limit, refusal and network errors", async () => {
  const authHandler = createHandler(async () => new Response("{}", { status: 401 }));
  assert.equal((await call(authHandler, validRequest)).body.code, "bad_api_key");

  const rateHandler = createHandler(async () => new Response("{}", { status: 429 }));
  assert.equal((await call(rateHandler, validRequest)).body.code, "rate_limited");

  const refusalHandler = createHandler(async () => new Response(JSON.stringify({
    output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
  }), { status: 200 }));
  assert.equal((await call(refusalHandler, validRequest)).body.code, "refusal");

  const networkHandler = createHandler(async () => { throw new Error("offline"); });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal((await call(networkHandler, validRequest)).body.code, "upstream_unreachable");
  } finally {
    console.error = originalError;
  }
});

