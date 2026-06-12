import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFeishu, withRetry, walkWikiNodes } from "../core/feishu.mjs";
import { syncFeishuDocs, renderDoc } from "../server/feishudocs.mjs";
import { fm } from "../core/card.mjs";

// ---------- 测试用假飞书：world 驱动（spaces / 节点树 / 正文），可数 raw_content 调用 ----------
const N = (token, title, { obj_type = "docx", edit = 1000, has_child = false } = {}) =>
  ({ node_token: token, obj_token: "o-" + token, obj_type, title, has_child, obj_edit_time: String(edit) });

const fakeReq = (world) => async (method, url, { params = {} } = {}) => {
  if (url === "/open-apis/wiki/v2/spaces") return { data: { items: world.spaces, has_more: false } };
  let m = url.match(/^\/open-apis\/wiki\/v2\/spaces\/([^/]+)\/nodes$/);
  if (m) {
    if (world.failNodes) throw new Error("nodes boom");
    const bySpace = world.nodes[m[1]] || {};
    return { data: { items: bySpace[params.parent_node_token || ""] || [], has_more: false } };
  }
  m = url.match(/^\/open-apis\/docx\/v1\/documents\/([^/]+)\/raw_content$/);
  if (m) { world.rawCalls = (world.rawCalls || 0) + 1; return { data: { content: world.content[m[1]] ?? "" } }; }
  throw new Error("unexpected url: " + url);
};

const mkWorld = () => ({
  spaces: [{ space_id: "sp1", name: "Team Wiki" }],
  nodes: { sp1: {
    "": [N("tokA", "PRD 主文档", { has_child: true }), N("tokB", "进度表", { obj_type: "sheet" })],
    tokA: [N("tokC", "客户笔记")],
  } },
  content: { "o-tokA": "正文A，含密钥 ghp_" + "A".repeat(36), "o-tokC": "正文C" },
  rawCalls: 0,
});

const syncOpts = (commits) => ({
  pace: 0, sleepFn: async () => {}, now: () => "2026-06-10T00:00:00.000Z", wikiBase: "https://t.feishu.cn",
  commitFn: async (dir, info) => { commits.push(info); return "sha-test"; },
});

// ---------- loadFeishu ----------
test("loadFeishu：缺文件 / 缺凭证 → null；配齐 → 默认值生效", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-cfg-"));
  assert.equal(loadFeishu(join(dir, "nope.yaml")), null);
  writeFileSync(join(dir, "bad.yaml"), "app_id: x\n");                       // 没 secret
  assert.equal(loadFeishu(join(dir, "bad.yaml")), null);
  writeFileSync(join(dir, "ok.yaml"), "app_id: cli_x\napp_secret: s\nwiki_base: https://t.feishu.cn///\n");
  const c = loadFeishu(join(dir, "ok.yaml"));
  assert.equal(c.poll_hours, 4);                                             // 默认 4h
  assert.equal(c.wiki_base, "https://t.feishu.cn");                          // 尾斜杠剥掉
});

// ---------- withRetry ----------
test("withRetry：429/5xx 退避重试后成功；4xx 业务错误不重试", async () => {
  let n = 0;
  const flaky = async () => { if (++n < 3) { const e = new Error("429"); e.response = { status: 429 }; throw e; } return "ok"; };
  assert.equal(await withRetry(flaky, { delays: [0, 0, 0], sleepFn: async () => {} }), "ok");
  assert.equal(n, 3);
  let tries = 0;
  const denied = async () => { tries++; const e = new Error("403"); e.response = { status: 403 }; throw e; };
  await assert.rejects(() => withRetry(denied, { delays: [0, 0], sleepFn: async () => {} }), /403/);
  assert.equal(tries, 1);                                                    // 权限错误重试无意义
});

// ---------- walkWikiNodes：分页 + 递归 + titlePath ----------
test("walkWikiNodes：翻页拼全、has_child 下钻、titlePath 是祖先链", async () => {
  const pages = {
    "|":   [{ items: [N("a", "A", { has_child: true })], has_more: true, page_token: "p2" },
            { items: [N("b", "B")], has_more: false }],
    "|a":  [{ items: [N("c", "C")], has_more: false }],
  };
  const served = {};
  const req = async (method, url, { params = {} } = {}) => {
    const key = "|" + (params.parent_node_token || "");
    const i = served[key] = (served[key] ?? -1) + 1;
    return { data: pages[key][i] };
  };
  const out = await walkWikiNodes(req, "sp");
  assert.deepEqual(out.map((x) => x.node.node_token), ["a", "c", "b"]);
  assert.deepEqual(out.find((x) => x.node.node_token === "c").titlePath, ["A"]);
});

// ---------- renderDoc ----------
test("renderDoc：frontmatter 齐全 + 正文脱敏 + url 拼接", () => {
  const txt = renderDoc({
    space: { space_id: "sp1", name: "Team Wiki" },
    node: N("tokC", "客户笔记", { edit: 1000 }),
    titlePath: ["PRD 主文档"],
    body: "密钥 ghp_" + "A".repeat(36),
    wikiBase: "https://t.feishu.cn", now: "2026-06-10T00:00:00.000Z",
  });
  assert.equal(fm(txt, "type"), "feishu-doc");
  assert.equal(fm(txt, "edited"), "1970-01-01T00:16:40.000Z");               // unix 秒 → ISO
  assert.equal(fm(txt, "parent"), "PRD 主文档");
  assert.equal(fm(txt, "url"), "https://t.feishu.cn/wiki/tokC");
  assert.match(txt, /\[REDACTED_GH\]/);                                      // 派生必脱敏
  assert.doesNotMatch(txt, /ghp_A/);
});

// ---------- sync 端到端 ----------
test("sync：首轮全写（docx 拉正文、sheet 写指针卡）、一轮一个 commit", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "fs-truth-"));
  const world = mkWorld(); const commits = [];
  const r = await syncFeishuDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.deepEqual([r.written, r.pruned, r.skipped, r.errors], [3, 0, 0, 0]);
  const dir = join(TRUTH, "feishu", "Team Wiki__sp1");
  const cTxt = readFileSync(join(dir, "客户笔记--tokC.md"), "utf8");
  assert.equal(fm(cTxt, "parent"), "PRD 主文档");                            // 子节点带祖先链
  assert.match(cTxt, /正文C/);
  assert.match(readFileSync(join(dir, "PRD 主文档--tokA.md"), "utf8"), /\[REDACTED_GH\]/);
  assert.match(readFileSync(join(dir, "进度表--tokB.md"), "utf8"), /sheet 类型，正文不入索引/);
  assert.equal(world.rawCalls, 2);                                           // 只有 2 个 docx 拉了正文
  assert.equal(commits.length, 1);
  assert.match(commits[0].message, /同步 3 篇/);
  assert.deepEqual(commits[0].paths, ["feishu"]);
});

test("sync 增量：obj_edit_time 没变 → 不拉正文、不重写、不 commit", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "fs-truth-"));
  const world = mkWorld(); const commits = [];
  await syncFeishuDocs(TRUTH, fakeReq(world), syncOpts(commits));
  const r2 = await syncFeishuDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.deepEqual([r2.written, r2.skipped], [0, 3]);
  assert.equal(world.rawCalls, 2);                                           // 第二轮零次 raw_content
  assert.equal(commits.length, 1);

  // 改了一篇（edit 时间 + 正文变）→ 只重拉重写这一篇
  world.nodes.sp1.tokA = [N("tokC", "客户笔记", { edit: 2000 })];
  world.content["o-tokC"] = "正文C v2";
  const r3 = await syncFeishuDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.deepEqual([r3.written, r3.skipped], [1, 2]);
  assert.match(readFileSync(join(TRUTH, "feishu", "Team Wiki__sp1", "客户笔记--tokC.md"), "utf8"), /正文C v2/);
});

test("sync 孤儿清理：节点从树里消失 → 镜像删掉；commit 信息带清理数", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "fs-truth-"));
  const world = mkWorld(); const commits = [];
  await syncFeishuDocs(TRUTH, fakeReq(world), syncOpts(commits));
  world.nodes.sp1[""] = [N("tokA", "PRD 主文档"), N("tokB", "进度表", { obj_type: "sheet" })];  // C 被删
  delete world.nodes.sp1.tokA;
  const r = await syncFeishuDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.equal(r.pruned, 1);
  assert.ok(!existsSync(join(TRUTH, "feishu", "Team Wiki__sp1", "客户笔记--tokC.md")));
  assert.match(commits.at(-1).message, /清理 1/);
});

test("sync 安全边界：遍历失败不清理；知识库列表为空整轮跳过", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "fs-truth-"));
  const world = mkWorld(); const commits = [];
  await syncFeishuDocs(TRUTH, fakeReq(world), syncOpts(commits));
  // ① 该库 nodes API 挂了 → 已有镜像原样保留
  world.failNodes = true;
  const r1 = await syncFeishuDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.ok(r1.errors >= 1);
  assert.ok(existsSync(join(TRUTH, "feishu", "Team Wiki__sp1", "客户笔记--tokC.md")));
  // ② 一个知识库都看不到（多半凭证/授权坏了）→ 跳过且不删
  world.failNodes = false; world.spaces = [];
  const r2 = await syncFeishuDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.equal(r2.errors, 1);
  assert.ok(existsSync(join(TRUTH, "feishu", "Team Wiki__sp1", "客户笔记--tokC.md")));
});

test("sync：整个知识库被取消授权/删除（列表里没了）→ 镜像目录清掉", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "fs-truth-"));
  const world = mkWorld(); const commits = [];
  await syncFeishuDocs(TRUTH, fakeReq(world), syncOpts(commits));
  world.spaces = [{ space_id: "sp2", name: "新库" }];
  world.nodes.sp2 = { "": [] };
  const r = await syncFeishuDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.ok(r.pruned >= 1);
  assert.ok(!existsSync(join(TRUTH, "feishu", "Team Wiki__sp1")));
});

test("sync 路径红线：node_token 含分隔符 → 该节点跳过不落盘，其余照写", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "fs-truth-"));
  const world = mkWorld(); const commits = [];
  world.nodes.sp1[""].push({ node_token: "../evil", obj_token: "o-evil", obj_type: "docx", title: "恶意", has_child: false, obj_edit_time: "1000" });
  const r = await syncFeishuDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.ok(r.errors >= 1);
  assert.equal(r.written, 3);                                                // 其余 3 篇照常
  assert.ok(!existsSync(join(TRUTH, "feishu", "Team Wiki__sp1", "恶意--../evil.md")));
  // 标题里的分隔符会被消毒（不报错、不穿越）
  rmSync(TRUTH, { recursive: true, force: true });
});
