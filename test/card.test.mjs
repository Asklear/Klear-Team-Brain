import test from "node:test";
import assert from "node:assert/strict";
import { buildCard, fm, daysFields, readDays } from "../core/card.mjs";

test("buildCard: 略过空值、写出非空字段 + 正文", () => {
  const card = buildCard(
    { id: "x1", producer: "user2", space_key: "local__user2", folder: "repo1/docs", empty: "", nil: null, undef: undefined },
    "**用户**：做点啥\n\n**助手**：搞定了",
  );
  assert.match(card, /^id: x1$/m);
  assert.match(card, /^producer: user2$/m);
  assert.match(card, /^folder: repo1\/docs$/m);
  assert.doesNotMatch(card, /^empty:/m);
  assert.doesNotMatch(card, /^nil:/m);
  assert.doesNotMatch(card, /^undef:/m);
  assert.match(card, /\*\*用户\*\*：做点啥/);   // 正文 = 全文 transcript（不再是「意图+结论」摘要）
  assert.match(card, /\*\*助手\*\*：搞定了/);
});

test("buildCard: 值里的换行被压平（防 frontmatter 注入）", () => {
  const card = buildCard({ branch: "main\nfake: evil" }, "");
  assert.match(card, /^branch: main fake: evil$/m);
  assert.doesNotMatch(card, /^fake: evil$/m);
});

test("buildCard: 空正文给占位", () => {
  assert.match(buildCard({ id: "x" }, ""), /（无可读对话）/);
});

test("daysFields ↔ readDays 往返：用量已知（6 元组），full 不落标志", () => {
  const days = [
    { date: "2026-06-20", turns: 1, in: 100, out: 10, cache_r: 0, cache_w: 5 },
    { date: "2026-06-21", turns: 3, in: 50, out: 20, cache_r: 300, cache_w: 0 },
  ];
  const card = buildCard({ date: "2026-06-20T23:00:00Z", ...daysFields(days, "full") }, "body");
  assert.doesNotMatch(card, /^tokens_daily:/m);   // full（精确分天）不需要标志位
  assert.deepEqual(readDays(card), [
    { date: "2026-06-20", turns: 1, usage: { in: 100, out: 10, cache_r: 0, cache_w: 5, total: 115 } },
    { date: "2026-06-21", turns: 3, usage: { in: 50, out: 20, cache_r: 300, cache_w: 0, total: 370 } },
  ]);
});

test("daysFields ↔ readDays：用量未知（2 元组）→ usage=null", () => {
  const card = buildCard({ ...daysFields([{ date: "2026-06-20", turns: 2 }], null) }, "body");
  assert.deepEqual(readDays(card), [{ date: "2026-06-20", turns: 2, usage: null }]);
});

test("daysFields: 近似口径（如 Codex 起始日）→ 落 tokens_daily=start", () => {
  const card = buildCard({ ...daysFields([{ date: "2026-06-20", turns: 1, in: 5, out: 1, cache_r: 0, cache_w: 0 }], "start") }, "b");
  assert.match(card, /^tokens_daily: start$/m);
});

test("readDays: 无 days 字段 → null", () => {
  assert.equal(readDays(buildCard({ date: "2026-06-20" }, "b")), null);
});

test("fm: 读 frontmatter 单字段", () => {
  const card = buildCard({ space_key: "github__o__r", branch: "feat-x", folder: "" }, "正文");
  const head = card.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.equal(fm(head, "space_key"), "github__o__r");
  assert.equal(fm(head, "branch"), "feat-x");
  assert.equal(fm(head, "missing"), "");
});
