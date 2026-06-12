import test from "node:test";
import assert from "node:assert/strict";
import { buildCard, fm } from "../core/card.mjs";

test("buildCard: 略过空值、写出非空字段 + 正文", () => {
  const card = buildCard(
    { id: "x1", producer: "hank", space_key: "local__hank", folder: "bossa/docs", empty: "", nil: null, undef: undefined },
    "**用户**：做点啥\n\n**助手**：搞定了",
  );
  assert.match(card, /^id: x1$/m);
  assert.match(card, /^producer: hank$/m);
  assert.match(card, /^folder: bossa\/docs$/m);
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

test("fm: 读 frontmatter 单字段", () => {
  const card = buildCard({ space_key: "github__o__r", branch: "feat-x", folder: "" }, "正文");
  const head = card.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.equal(fm(head, "space_key"), "github__o__r");
  assert.equal(fm(head, "branch"), "feat-x");
  assert.equal(fm(head, "missing"), "");
});
