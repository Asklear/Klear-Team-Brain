import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNotion, withRetry, searchPages, pageTitle, pageBlocksText } from "../core/notion.mjs";
import { syncNotionDocs, renderDoc } from "../server/notiondocs.mjs";
import { fm } from "../core/card.mjs";

// ---------- 测试用假 Notion：world 驱动（pages / 每页 block 树），可数 children 调用 ----------
const page = (id, title, { edited = "2026-06-01T00:00:00.000Z", url = "https://www.notion.so/" + id } = {}) => ({
  object: "page", id, url, last_edited_time: edited,
  properties: { Name: { type: "title", title: [{ plain_text: title }] } },
});
const para = (id, text, { has_children = false } = {}) =>
  ({ id, type: "paragraph", has_children, paragraph: { rich_text: [{ plain_text: text }] } });

const fakeReq = (world) => async (method, path) => {
  if (method === "POST" && path === "/search") {
    if (world.failSearch) throw Object.assign(new Error("search boom"), { status: 500 });
    return { results: world.pages, has_more: false };
  }
  const m = path.match(/^\/blocks\/([^/?]+)\/children/);
  if (method === "GET" && m) {
    world.blockCalls = (world.blockCalls || 0) + 1;
    return { results: world.blocks[m[1]] || [], has_more: false };
  }
  throw new Error("unexpected: " + method + " " + path);
};

const mkWorld = () => ({
  pages: [
    page("pageA", "PRD 主文档", { edited: "2026-06-01T00:00:00.000Z" }),
    page("pageB", "客户笔记", { edited: "2026-06-02T00:00:00.000Z" }),
  ],
  blocks: {
    pageA: [para("a1", "正文A，含密钥 ghp_" + "A".repeat(36))],
    pageB: [para("b1", "正文C")],
  },
  blockCalls: 0,
});

const syncOpts = (commits) => ({
  pace: 0, sleepFn: async () => {}, now: () => "2026-06-10T00:00:00.000Z", workspace: "Team Notion",
  commitFn: async (_dir, info) => { commits.push(info); return "sha-test"; },
});

// ---------- loadNotion ----------
test("loadNotion：缺文件 / 缺 token → null；配齐 → 默认值生效", () => {
  const dir = mkdtempSync(join(tmpdir(), "nt-cfg-"));
  assert.equal(loadNotion(join(dir, "nope.yaml")), null);
  writeFileSync(join(dir, "bad.yaml"), "poll_hours: 6\n");                    // 没 api_token
  assert.equal(loadNotion(join(dir, "bad.yaml")), null);
  writeFileSync(join(dir, "ok.yaml"), "api_token: secret_x\n");
  const c = loadNotion(join(dir, "ok.yaml"));
  assert.equal(c.poll_hours, 4);                                             // 默认 4h
  assert.equal(c.workspace, "notion");                                       // 默认目录名
  writeFileSync(join(dir, "ok2.yaml"), "api_token: secret_x\npoll_hours: 6\nworkspace: KB\n");
  assert.deepEqual(
    (({ poll_hours, workspace }) => ({ poll_hours, workspace }))(loadNotion(join(dir, "ok2.yaml"))),
    { poll_hours: 6, workspace: "KB" });
});

// ---------- withRetry ----------
test("withRetry：429/5xx 退避重试后成功；4xx 业务错误不重试", async () => {
  let n = 0;
  const flaky = async () => { if (++n < 3) throw Object.assign(new Error("429"), { status: 429 }); return "ok"; };
  assert.equal(await withRetry(flaky, { delays: [0, 0, 0], sleepFn: async () => {} }), "ok");
  assert.equal(n, 3);
  let tries = 0;
  const denied = async () => { tries++; throw Object.assign(new Error("403"), { status: 403 }); };
  await assert.rejects(() => withRetry(denied, { delays: [0, 0], sleepFn: async () => {} }), /403/);
  assert.equal(tries, 1);                                                    // 权限错误重试无意义
});

// ---------- pageTitle / searchPages 分页 ----------
test("pageTitle：取 type=title 的属性拼 plain_text；缺则 untitled", () => {
  assert.equal(pageTitle(page("p", "我的页")), "我的页");
  assert.equal(pageTitle({ properties: { N: { type: "rich_text", rich_text: [] } } }), "untitled");
  assert.equal(pageTitle({}), "untitled");
});

test("searchPages：翻页拼全（cursor 在 body）", async () => {
  const pages = [
    { results: [page("p1", "A")], has_more: true, next_cursor: "c2" },
    { results: [page("p2", "B")], has_more: false },
  ];
  let i = 0;
  const req = async (method, path, body) => {
    assert.equal(method, "POST"); assert.equal(path, "/search");
    if (i === 1) assert.equal(body.start_cursor, "c2");                      // 第二页带上一页游标
    return pages[i++];
  };
  const out = await searchPages(req);
  assert.deepEqual(out.map((p) => p.id), ["p1", "p2"]);
});

// ---------- pageBlocksText：递归 + 子块下钻 ----------
test("pageBlocksText：拼各块文本、has_children 下钻", async () => {
  const world = {
    blocks: {
      root: [para("x1", "第一段"), para("x2", "带子块", { has_children: true })],
      x2: [para("x3", "子段")],
    },
  };
  const txt = await pageBlocksText(fakeReq(world), "root", { pace: 0, sleepFn: async () => {} });
  assert.equal(txt, "第一段\n带子块\n子段");
});

// ---------- renderDoc ----------
test("renderDoc：frontmatter 齐全 + 正文脱敏 + url", () => {
  const txt = renderDoc({
    collection: { id: "workspace", name: "Team Notion" },
    node: { id: "pageA", title: "PRD 主文档", last_edited_time: "2026-06-01T00:00:00.000Z", url: "https://www.notion.so/pageA" },
    body: "密钥 ghp_" + "A".repeat(36),
    now: "2026-06-10T00:00:00.000Z",
  });
  assert.equal(fm(txt, "type"), "notion-doc");
  assert.equal(fm(txt, "edited"), "2026-06-01T00:00:00.000Z");
  assert.equal(fm(txt, "workspace"), "Team Notion");
  assert.equal(fm(txt, "page_id"), "pageA");
  assert.equal(fm(txt, "url"), "https://www.notion.so/pageA");
  assert.match(txt, /\[REDACTED_GH\]/);                                      // 派生必脱敏
  assert.doesNotMatch(txt, /ghp_A/);
});

// ---------- sync 端到端 ----------
test("sync：首轮全写、拉正文脱敏、一轮一个 commit", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "nt-truth-"));
  const world = mkWorld(); const commits = [];
  const r = await syncNotionDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.deepEqual([r.written, r.pruned, r.skipped, r.errors], [2, 0, 0, 0]);
  const dir = join(TRUTH, "notion", "Team Notion");
  assert.match(readFileSync(join(dir, "PRD 主文档--pageA.md"), "utf8"), /\[REDACTED_GH\]/);
  assert.match(readFileSync(join(dir, "客户笔记--pageB.md"), "utf8"), /正文C/);
  assert.equal(world.blockCalls, 2);                                         // 两页各拉一次正文
  assert.equal(commits.length, 1);
  assert.match(commits[0].message, /同步 2 篇/);
  assert.deepEqual(commits[0].paths, ["notion"]);
  rmSync(TRUTH, { recursive: true, force: true });
});

test("sync 增量：last_edited_time 没变 → 不拉正文、不重写、不 commit；改一篇只重拉一篇", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "nt-truth-"));
  const world = mkWorld(); const commits = [];
  await syncNotionDocs(TRUTH, fakeReq(world), syncOpts(commits));
  const r2 = await syncNotionDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.deepEqual([r2.written, r2.skipped], [0, 2]);
  assert.equal(world.blockCalls, 2);                                         // 第二轮零次 children
  assert.equal(commits.length, 1);

  world.pages[1] = page("pageB", "客户笔记", { edited: "2026-06-09T00:00:00.000Z" });
  world.blocks.pageB = [para("b1", "正文C v2")];
  const r3 = await syncNotionDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.deepEqual([r3.written, r3.skipped], [1, 1]);
  assert.match(readFileSync(join(TRUTH, "notion", "Team Notion", "客户笔记--pageB.md"), "utf8"), /正文C v2/);
  rmSync(TRUTH, { recursive: true, force: true });
});

test("sync 孤儿清理：页面消失 → 镜像删掉；commit 带清理数", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "nt-truth-"));
  const world = mkWorld(); const commits = [];
  await syncNotionDocs(TRUTH, fakeReq(world), syncOpts(commits));
  world.pages = [page("pageA", "PRD 主文档")];                              // pageB 没了
  const r = await syncNotionDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.equal(r.pruned, 1);
  assert.ok(!existsSync(join(TRUTH, "notion", "Team Notion", "客户笔记--pageB.md")));
  assert.match(commits.at(-1).message, /清理 1/);
  rmSync(TRUTH, { recursive: true, force: true });
});

test("sync 安全边界：search 失败不清理；可见页面为空整轮跳过", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "nt-truth-"));
  const world = mkWorld(); const commits = [];
  await syncNotionDocs(TRUTH, fakeReq(world), syncOpts(commits));
  const live = join(TRUTH, "notion", "Team Notion", "PRD 主文档--pageA.md");
  // ① search 挂了 → 已有镜像原样保留
  world.failSearch = true;
  const r1 = await syncNotionDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.equal(r1.errors, 1);
  assert.ok(existsSync(live));
  // ② 一个页面都看不到（多半凭证/授权坏了）→ 跳过且不删
  world.failSearch = false; world.pages = [];
  const r2 = await syncNotionDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.equal(r2.errors, 1);
  assert.ok(existsSync(live));
  rmSync(TRUTH, { recursive: true, force: true });
});

test("sync 路径红线：page id 含分隔符 → 该页跳过不落盘，其余照写", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "nt-truth-"));
  const world = mkWorld(); const commits = [];
  world.pages.push(page("../evil", "恶意"));
  const r = await syncNotionDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.ok(r.errors >= 1);
  assert.equal(r.written, 2);                                               // 其余 2 篇照常
  assert.ok(!existsSync(join(TRUTH, "notion", "Team Notion", "恶意--../evil.md")));
  rmSync(TRUTH, { recursive: true, force: true });
});
