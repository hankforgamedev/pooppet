/**
 * 真的開一顆 Chromium 跑 index.html，把 /api/judge 換成假的，
 * 驗累積制、⚙ 指定、以及判讀掛掉時的退路。
 */
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = path.resolve(import.meta.dirname, "..");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVR42mP8z8BQz0AEYBxVSF+F" +
    "jFDwn4EIwDiqkL4KAcAaBQeYD5wOAAAAAElFTkSuQmCC",
  "base64",
);

const types = { ".html": "text/html", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const shot = path.join(ROOT, "test", "feed.png");
fs.writeFileSync(shot, PNG);

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const results = [];
let verdict = { is_stool: true, bristol: "1", oily: false, confidence: "high", note: "硬得像石頭" };
let judgeStatus = 200;
let judgeCalls = 0;

async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await ctx.newPage();
  // 測試不打外部網路：Google Fonts 在這台機器上要 12 秒，測試也不該依賴它
  await page.route("**fonts.googleapis.com/**", (r) => r.abort());
  await page.route("**fonts.gstatic.com/**", (r) => r.abort());
  await page.route("**/api/judge", async (route) => {
    judgeCalls++;
    await route.fulfill({
      status: judgeStatus,
      contentType: "application/json",
      body: JSON.stringify(judgeStatus === 200 ? verdict : { error: "boom", code: "upstream_error" }),
    });
  });
  await page.goto(base);
  // AI 判讀預設是關的，測判讀路徑要先打開
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("pooppet.ai.v1", "1");
  });
  await page.reload();
  await page.click("#intro");
  return { ctx, page };
}

/** 餵一張，等雞吃完並揭曉 */
async function feedOnce(page) {
  await page.setInputFiles("#libIn", shot);
  // 先等牠真的開始吃，否則 setInputFiles 一回來就過了（feed() 是 async 的）
  await page.waitForFunction(() => chick.mode === "eat", null, { timeout: 10000 });
  await page.waitForFunction(() => chick.mode === "idle" && !waiting, null, { timeout: 20000 });
  await page.waitForTimeout(150);
}

async function check(name, fn) {
  try {
    await fn();
    results.push(`  PASS  ${name}`);
  } catch (e) {
    results.push(`  FAIL  ${name}\n        ${e.message.split("\n")[0]}`);
    process.exitCode = 1;
  }
}

// 1. 累積制：Bristol 1 一次不變形，兩次才變石化
await check("Bristol 1 餵一次 → 不變形，只記一筆", async () => {
  const { ctx, page } = await fresh();
  await feedOnce(page);
  assert.equal(await page.evaluate(() => state), "normal");
  assert.match(await page.textContent("#cardTitle"), /記下來了/);
  // 進度只記在 hist，畫面上不再有計數器
  assert.deepEqual(await page.evaluate(() => hist), [["stone"]]);
  await ctx.close();
});

await check("Bristol 1 餵兩次 → 石化", async () => {
  const { ctx, page } = await fresh();
  await feedOnce(page);
  await feedOnce(page);
  assert.equal(await page.evaluate(() => state), "stone");
  assert.match(await page.textContent("#cardTitle"), /石化了/);
  await ctx.close();
});

// 2. 解除：石化後連餵兩次 Bristol 3（無訊號）→ 變回正常
await check("石化後兩次無訊號 → 解除回正常", async () => {
  const { ctx, page } = await fresh();
  await feedOnce(page);
  await feedOnce(page);
  assert.equal(await page.evaluate(() => state), "stone");
  verdict = { ...verdict, bristol: "3", note: "還行" };
  await feedOnce(page);
  await feedOnce(page);
  assert.equal(await page.evaluate(() => state), "normal");
  assert.match(await page.textContent("#cardTitle"), /解除/);
  verdict = { ...verdict, bristol: "1", note: "硬得像石頭" };
  await ctx.close();
});

// 3. Bristol 4 兩次 → 完美
await check("Bristol 4 兩次 → 完美", async () => {
  const { ctx, page } = await fresh();
  verdict = { ...verdict, bristol: "4", note: "一次成型" };
  await feedOnce(page);
  await feedOnce(page);
  assert.equal(await page.evaluate(() => state), "perfect");
  verdict = { ...verdict, bristol: "1", note: "硬得像石頭" };
  await ctx.close();
});

// 4. 油亮優先於 Bristol：oily=true 兩次 → 油亮
await check("油亮兩次 → 油亮（蓋過 Bristol 4）", async () => {
  const { ctx, page } = await fresh();
  verdict = { ...verdict, bristol: "4", oily: true };
  await feedOnce(page);
  await feedOnce(page);
  assert.equal(await page.evaluate(() => state), "oily");
  verdict = { ...verdict, bristol: "1", oily: false };
  await ctx.close();
});

// 5. ⚙ 指定：一次就變形，而且完全不打 API
await check("⚙ 指定石化 → 一次生效且不打 API", async () => {
  const { ctx, page } = await fresh();
  const before = judgeCalls;
  await page.click("#gear");
  await page.click("#devBtns button[data-k=stone]");
  await page.click("#devClose");
  await feedOnce(page);
  assert.equal(await page.evaluate(() => state), "stone");
  assert.equal(judgeCalls, before, "⚙ 指定時不應該打 API");
  assert.match(await page.textContent("#cardTip"), /⚙ 指定/);
  await ctx.close();
});

// 6. 判讀掛掉 → 退回 demo 模式，不卡住
await check("API 500 → 退回隨機，雞不會卡在咀嚼", async () => {
  const { ctx, page } = await fresh();
  judgeStatus = 500;
  await feedOnce(page);
  assert.equal(await page.evaluate(() => chick.mode), "idle");
  assert.match(await page.textContent("#cardTip"), /判讀連不上/);
  judgeStatus = 200;
  await ctx.close();
});

// 7. 不是便便 → 雞照吃，但不記帳
await check("is_stool=false → 不變形，出「這不是便便」", async () => {
  const { ctx, page } = await fresh();
  verdict = { is_stool: false, bristol: "none", oily: false, confidence: "high", note: "這不是便便" };
  await feedOnce(page);
  await feedOnce(page);
  assert.equal(await page.evaluate(() => state), "normal");
  assert.match(await page.textContent("#cardTitle"), /這不是便便/);
  verdict = { is_stool: true, bristol: "1", oily: false, confidence: "high", note: "硬得像石頭" };
  await ctx.close();
});

// 8. 辣是用戶自填，兩次 → 噴火
await check("🌶 自填兩次 → 噴火", async () => {
  const { ctx, page } = await fresh();
  verdict = { ...verdict, bristol: "3" };
  await page.click("#chili");
  await feedOnce(page);
  await page.click("#chili");
  await feedOnce(page);
  assert.equal(await page.evaluate(() => state), "spicy");
  verdict = { ...verdict, bristol: "1" };
  await ctx.close();
});

// 9. 送出去的圖有被縮過
await check("送給 API 的是縮過的 JPEG data URL", async () => {
  const { ctx, page } = await fresh();
  let sent = null;
  await page.route("**/api/judge", async (route) => {
    sent = JSON.parse(route.request().postData());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(verdict) });
  });
  await feedOnce(page);
  assert.ok(sent, "沒有送出 request");
  assert.match(sent.image, /^data:image\/jpeg;base64,/);
  await ctx.close();
});

// 10. 累積狀態跨重開留著
await check("重開 app 之後累積狀態還在", async () => {
  const { ctx, page } = await fresh();
  await feedOnce(page);
  await feedOnce(page);
  assert.equal(await page.evaluate(() => state), "stone");
  await page.reload();
  await page.click("#intro");
  assert.equal(await page.evaluate(() => state), "stone");
  await ctx.close();
});

// 11. 預設就是 demo 模式：不打 API，⚙ 指定照樣有效
await check("預設 AI 判讀是關的 → 不打 API", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await ctx.newPage();
  // 測試不打外部網路：Google Fonts 在這台機器上要 12 秒，測試也不該依賴它
  await page.route("**fonts.googleapis.com/**", (r) => r.abort());
  await page.route("**fonts.gstatic.com/**", (r) => r.abort());
  let called = 0;
  await page.route("**/api/judge", async (route) => {
    called++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(verdict) });
  });
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click("#intro");
  assert.equal(await page.evaluate(() => aiOn), false, "預設應該是關的");
  await feedOnce(page);
  assert.equal(called, 0, "預設不應該打 API");
  assert.match(await page.textContent("#cardTip"), /demo 模式/);
  await ctx.close();
});

// 12-17. 牠自己的便便
await check("餵 4 次 → 欠一次大便，而且是在畫面上大出來的", async () => {
  const { ctx, page } = await fresh();
  for (let i = 0; i < 3; i++) await feedOnce(page);
  assert.equal(await page.evaluate(() => poopDue), false, "第 3 次還不該欠");
  assert.equal(await page.evaluate(() => poops.length), 0);
  await feedOnce(page);
  assert.equal(await page.evaluate(() => poopDue), true, "第 4 次之後該欠一次");
  // 欠著不代表已經大了 —— 要等牠閒下來、在畫面上蹲完才算
  await page.waitForFunction(() => poops.length === 1, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => poopDue), false);
  await ctx.close();
});

await check("牠自己大的比餵進去的小很多", async () => {
  const { ctx, page } = await fresh();
  const size = await page.evaluate(() => {
    const s = scale();
    // 牠自己大的：8 格 × s*0.55
    const own = 8 * Math.max(1, s * 0.55);
    // 餵進去的那張：飛進來時是 34% 短邊，跟雞差不多高
    const fed = Math.min(W, H) * 0.34;
    return { own, fed, chick: 16 * s };
  });
  assert.ok(size.own < size.chick * 0.45, `自己大的應該明顯小於雞：${size.own} vs ${size.chick}`);
  assert.ok(size.fed > size.chick * 0.8, `餵進去的應該跟雞差不多大：${size.fed} vs ${size.chick}`);
  await ctx.close();
});

await check("點便便可以清掉，而且不會順便丟球", async () => {
  const { ctx, page } = await fresh();
  await page.evaluate(() => { poopDue = true; poopIn = 0; ball = null; });
  await page.waitForFunction(() => poops.length === 1, null, { timeout: 15000 });
  const box = await page.evaluate(() => {
    const r = document.getElementById("stage").getBoundingClientRect();
    return { x: r.left + poops[0].x, y: r.top + ground - scale() * 2 };
  });
  await page.mouse.click(box.x, box.y);
  assert.equal(await page.evaluate(() => poops.length), 0, "應該清掉了");
  assert.equal(await page.evaluate(() => ball), null, "清便便不該同時丟球");
  await ctx.close();
});

await check("放著不清 → 倒數歸零之後牠自己吃掉", async () => {
  const { ctx, page } = await fresh();
  await page.evaluate(() => {
    CLEAN_SEC = 1.5;            // 測試不等 60 秒
    poopDue = true; poopIn = 0; ball = null;
  });
  await page.waitForFunction(() => poops.length === 1, null, { timeout: 15000 });
  await page.waitForFunction(() => poops.length === 0, null, { timeout: 20000 });
  assert.match(await page.textContent("#cardTitle"), /吃掉/);
  await ctx.close();
});

await check("切到背景時倒數凍結，不在後台偷跑", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await ctx.newPage();
  // 測試不打外部網路：Google Fonts 在這台機器上要 12 秒，測試也不該依賴它
  await page.route("**fonts.googleapis.com/**", (r) => r.abort());
  await page.route("**fonts.gstatic.com/**", (r) => r.abort());
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click("#intro");
  await page.evaluate(() => { poopDue = true; poopIn = 0; ball = null; });
  await page.waitForFunction(() => poops.length === 1, null, { timeout: 15000 });

  // 假裝使用者切走：visibilityState 變 hidden
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const before = await page.evaluate(() => poops[0].age);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => poops[0].age);
  assert.ok(after - before < 0.2, `背景時倒數不該前進：${before} → ${after}`);

  // 回到前景，倒數繼續
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(800);
  assert.ok(await page.evaluate(() => poops[0].age) > after + 0.3, "回到前景要繼續算");
  await ctx.close();
});

await check("地上的便便跨重開還在，倒數接著算", async () => {
  const { ctx, page } = await fresh();
  await page.evaluate(() => { poopDue = true; poopIn = 0; ball = null; });
  await page.waitForFunction(() => poops.length === 1, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  const age = await page.evaluate(() => poops[0].age);
  await page.reload();
  await page.click("#intro");
  assert.equal(await page.evaluate(() => poops.length), 1, "重開之後便便還在");
  assert.ok(await page.evaluate(() => poops[0].age) >= age - 0.5, "累積的時間要留著");
  await ctx.close();
});

await check("⚙ 馬上大便 + 清掉地上全部", async () => {
  const { ctx, page } = await fresh();
  await page.click("#gear");
  await page.click("#devPoop button:nth-child(1)");
  await page.waitForFunction(() => poops.length === 1, null, { timeout: 15000 });
  await page.click("#gear");
  await page.click("#devPoop button:nth-child(3)");
  assert.equal(await page.evaluate(() => poops.length), 0);
  await ctx.close();
});

// 19. 螢幕上不再有狀態列與倒數
await check("LCD 上方不再有 badge / 倒數計時器", async () => {
  const { ctx, page } = await fresh();
  assert.equal(await page.locator("#badge").count(), 0, "badge 應該整個拿掉");
  assert.equal(await page.locator("#timer").count(), 0, "倒數計時器應該整個拿掉");
  await page.evaluate(() => { poopDue = true; poopIn = 0; ball = null; });
  await page.waitForFunction(() => poops.length === 1, null, { timeout: 15000 });
  assert.equal(await page.locator("#timer").count(), 0, "有便便的時候也不該冒出倒數");
  await ctx.close();
});

await check("預設倒數是 30 秒", async () => {
  const { ctx, page } = await fresh();
  assert.equal(await page.evaluate(() => CLEAN_SEC_DEFAULT), 30);
  assert.equal(await page.evaluate(() => CLEAN_SEC), 30);
  await ctx.close();
});

// 21. 馬桶外框：雞不能走進陶瓷裡，收起來的卡片不能擋到按鈕
await check("雞被關在橢圓水面裡，走不進陶瓷", async () => {
  const { ctx, page } = await fresh();
  const r = await page.evaluate(() => {
    const b = bounds();
    // 邊界必須落在該高度的橢圓寬度之內
    const half = halfAt(ground);
    return { lo: b.lo, hi: b.hi, left: W / 2 - half, right: W / 2 + half, W };
  });
  assert.ok(r.lo > r.left, `左界要在水面內：${r.lo} vs ${r.left}`);
  assert.ok(r.hi < r.right, `右界要在水面內：${r.hi} vs ${r.right}`);
  // 走一段時間之後仍然在界內
  await page.waitForTimeout(2500);
  const x = await page.evaluate(() => chick.x);
  assert.ok(x >= r.lo - 1 && x <= r.hi + 1, `雞跑出界了：${x}`);
  await ctx.close();
});

await check("收起來的判讀卡不會擋到拍照按鈕", async () => {
  const { ctx, page } = await fresh();
  const st = await page.evaluate(() => {
    const c = getComputedStyle(document.getElementById("card"));
    return { visibility: c.visibility, opacity: c.opacity, pointerEvents: c.pointerEvents };
  });
  assert.equal(st.visibility, "hidden");
  assert.equal(st.opacity, "0");
  assert.equal(st.pointerEvents, "none");
  // 按鈕真的按得到
  await page.click("#camBtn", { trial: true });
  await ctx.close();
});

await browser.close();
server.close();
fs.unlinkSync(shot);

console.log(results.join("\n"));
console.log(process.exitCode ? "\nFAILED" : `\n${results.length} passed`);
