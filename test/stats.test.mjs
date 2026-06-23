import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionText } from "../core/parse.mjs";
import { slimRaw } from "../core/slim.mjs";
import { buildCard, usageFields, readUsage } from "../core/card.mjs";
import { statsTruth } from "../server/query.mjs";

// ---------- parse：token 用量抽取 ----------

test("CC: 逐条 assistant.message.usage 累加成 session 总量", () => {
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-06-20T01:00:00Z", message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-06-20T01:01:00Z", message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 200 } } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-06-20T01:02:00Z", message: { content: [{ type: "text", text: "b" }], usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 300 } } }),
  ].join("\n");
  const s = parseSessionText(raw, "claude-code");
  assert.deepEqual(s.usage, { in: 150, out: 30, cache_r: 500, cache_w: 5 });
});

test("CC: 无 usage 字段 → usage=null（未知，区别于真 0）", () => {
  const raw = JSON.stringify({ type: "assistant", timestamp: "2026-06-20T01:00:00Z", message: { content: [{ type: "text", text: "a" }] } });
  assert.equal(parseSessionText(raw, "claude-code").usage, null);
});

test("Codex: 取 token_count 累计值，input 拆出 cached → cache_r", () => {
  const raw = [
    JSON.stringify({ type: "session_meta", timestamp: "2026-06-20T02:00:00Z", payload: { cwd: "/w" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-20T02:01:00Z", payload: { type: "user_message", message: "go" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-20T02:02:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 14670, cached_input_tokens: 3456, output_tokens: 280, total_tokens: 14950 } } } }),
  ].join("\n");
  const s = parseSessionText(raw, "codex");
  // in = 14670 - 3456 = 11214 · cache_r = 3456 · out = 280 · cache_w = 0
  assert.deepEqual(s.usage, { in: 11214, out: 280, cache_r: 3456, cache_w: 0 });
});

// ---------- slim：Codex token_count 只留末条累计 ----------

test("slim: Codex 多条 token_count → 仅保留最后一条（累计）", () => {
  const raw = [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 5 } } } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "go" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 40 } } } }),
  ].join("\n");
  const slimmed = slimRaw(raw);
  const tcLines = slimmed.split("\n").filter((l) => l.includes('"token_count"'));
  assert.equal(tcLines.length, 1, "只该留一条 token_count");
  // 留的是末条累计 → parse 出 in=400 cache_r=100 out=40
  assert.deepEqual(parseSessionText(slimmed, "codex").usage, { in: 400, out: 40, cache_r: 100, cache_w: 0 });
});

// ---------- card：usageFields / readUsage 往返 ----------

test("card: usageFields → frontmatter → readUsage 往返一致", () => {
  const usage = { in: 150, out: 30, cache_r: 500, cache_w: 5 };
  const card = buildCard({ date: "2026-06-20T01:00:00Z", ...usageFields(usage) }, "body");
  assert.match(card, /tokens_total: 685/);   // 150+30+500+5
  const back = readUsage(card);
  assert.deepEqual(back, { in: 150, out: 30, cache_r: 500, cache_w: 5, total: 685 });
});

test("card: 无 token 字段 → readUsage=null", () => {
  assert.equal(readUsage(buildCard({ date: "2026-06-20T01:00:00Z" }, "body")), null);
});

// ---------- statsTruth：聚合 ----------

function makeTruth(cards) {
  const dir = mkdtempSync(join(tmpdir(), "tb-stats-"));
  for (const c of cards) {
    const abs = join(dir, "spaces", c.space, "sessions", c.branch || "main", `${c.who}-${c.id}.md`);
    mkdirSync(join(dir, "spaces", c.space, "sessions", c.branch || "main"), { recursive: true });
    writeFileSync(abs, buildCard({
      date: c.date, updated: c.updated || c.date, producer_id: c.who,
      submitter: c.who, tool: c.tool || "claude-code", turns: c.turns ?? 1,
      ...usageFields(c.usage),
    }, "body"));
  }
  return dir;
}

const TRUTH = makeTruth([
  { space: "github__o__r", who: "hank", id: "s1", date: "2026-06-20T01:00:00Z", tool: "claude-code", turns: 3, usage: { in: 100, out: 10, cache_r: 0, cache_w: 0 } },
  { space: "github__o__r", who: "tqt", id: "s2", date: "2026-06-20T05:00:00Z", tool: "codex", turns: 2, usage: { in: 200, out: 20, cache_r: 0, cache_w: 0 } },
  { space: "local__hank", who: "hank", id: "s3", date: "2026-06-21T03:00:00Z", tool: "claude-code", turns: 5, usage: { in: 300, out: 30, cache_r: 0, cache_w: 0 } },
  { space: "github__o__r", who: "tqt", id: "s4", date: "2026-06-21T09:00:00Z", tool: "codex", turns: 1 }, // 无 usage（如老 Codex）
]);

test("statsTruth: by=day 倒序（新→旧），coverage 标无用量条数", async () => {
  const r = await statsTruth(TRUTH, { by: "day" });
  assert.deepEqual(r.rows.map((x) => x.key), ["2026-06-21", "2026-06-20"]);   // 新在前
  assert.equal(r.rows[0].tokens_total, 330);   // 06-21：330（s4 无 usage → 0）
  assert.equal(r.rows[1].tokens_total, 330);   // 06-20：110 + 220
  assert.equal(r.totals.tokens_total, 660);
  assert.equal(r.coverage.sessions, 4);
  assert.equal(r.coverage.with_usage, 3);      // s4 不算
});

test("statsTruth: 翻页 offset/limit + total + peak", async () => {
  const p1 = await statsTruth(TRUTH, { by: "day", limit: 1, offset: 0 });
  assert.deepEqual(p1.rows.map((x) => x.key), ["2026-06-21"]);   // 第 1 页 = 最新一天
  assert.equal(p1.total, 2);
  assert.equal(p1.offset, 0);
  assert.equal(p1.truncated, true);             // 还有下一页
  assert.equal(p1.peak, 330);                   // 全量峰值（两天都 330）
  const p2 = await statsTruth(TRUTH, { by: "day", limit: 1, offset: 1 });
  assert.deepEqual(p2.rows.map((x) => x.key), ["2026-06-20"]);   // 第 2 页 = 次新
  assert.equal(p2.truncated, false);            // 末页
});

test("statsTruth: by=person 按指标降序", async () => {
  const r = await statsTruth(TRUTH, { by: "person" });
  assert.deepEqual(r.rows.map((x) => x.key), ["hank", "tqt"]);   // hank 440 > tqt 220
  assert.equal(r.rows[0].tokens_total, 440);
  assert.equal(r.rows[0].sessions, 2);
});

test("statsTruth: by 多选组合键（day,person）— 首维时间倒序、同段内指标降序", async () => {
  const r = await statsTruth(TRUTH, { by: "day,person" });
  assert.deepEqual(r.dims, ["day", "person"]);
  // 06-21 段在前（新→旧）：hank(s3=330) > tqt(s4=0)；06-20 段：tqt(s2=220) > hank(s1=110)
  assert.deepEqual(r.rows.map((x) => x.key), [
    "2026-06-21 · hank", "2026-06-21 · tqt", "2026-06-20 · tqt", "2026-06-20 · hank",
  ]);
  assert.deepEqual(r.rows[0].keys, ["2026-06-21", "hank"]);
  assert.equal(r.rows[0].tokens_total, 330);
});

test("statsTruth: by 多选去重 + 首维非时间则全按指标降序", async () => {
  const r = await statsTruth(TRUTH, { by: "person,person,tool" });   // 去重 → person,tool
  assert.deepEqual(r.dims, ["person", "tool"]);
  // 首维 person 非时间 → 全按指标降序：hank/cc 440 最高
  assert.equal(r.rows[0].key, "hank · claude-code");
  assert.equal(r.rows[0].tokens_total, 440);
});

test("statsTruth: by=day split=person 二维", async () => {
  const r = await statsTruth(TRUTH, { by: "day", split: "person" });
  const d20 = r.rows.find((x) => x.key === "2026-06-20");
  const cells = Object.fromEntries(d20.cells.map((c) => [c.key, c.tokens_total]));
  assert.deepEqual(cells, { hank: 110, tqt: 220 });
});

test("statsTruth: since/until 按工作时间过滤", async () => {
  const r = await statsTruth(TRUTH, { by: "day", since: "2026-06-21" });
  assert.deepEqual(r.rows.map((x) => x.key), ["2026-06-21"]);
});

test("statsTruth: tool 维度 + metric=sessions", async () => {
  const r = await statsTruth(TRUTH, { by: "tool", metric: "sessions" });
  const m = Object.fromEntries(r.rows.map((x) => [x.key, x.sessions]));
  assert.deepEqual(m, { "claude-code": 2, codex: 2 });
});

test("statsTruth: 坏维度被拒", async () => {
  await assert.rejects(() => statsTruth(TRUTH, { by: "nonsense" }), /bad by/);
});
