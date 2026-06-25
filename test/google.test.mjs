import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGoogle, withRetry, listDocs } from "../core/google.mjs";
import { syncGoogleDocs, renderDoc } from "../server/googledocs.mjs";
import { fm } from "../core/card.mjs";

// ---------- 测试用假 Google：world 驱动（Drive 文件列表 / 各文档导出文本），可数 export 调用 ----------
const doc = (id, name, { modified = "2026-06-01T00:00:00.000Z" } = {}) =>
  ({ id, name, modifiedTime: modified, webViewLink: "https://docs.google.com/document/d/" + id });

const fakeReq = (world) => async (method, path, { raw = false } = {}) => {
  if (method === "GET" && path.startsWith("/files?")) {
    if (world.failList) throw Object.assign(new Error("list boom"), { status: 500 });
    return { files: world.docs, nextPageToken: "" };
  }
  const m = path.match(/^\/files\/([^/?]+)\/export/);
  if (method === "GET" && m && raw) {
    world.exportCalls = (world.exportCalls || 0) + 1;
    return world.content[m[1]] ?? "";
  }
  throw new Error("unexpected: " + method + " " + path + " raw=" + raw);
};

const mkWorld = () => ({
  docs: [
    doc("docA", "PRD 主文档", { modified: "2026-06-01T00:00:00.000Z" }),
    doc("docB", "客户笔记", { modified: "2026-06-02T00:00:00.000Z" }),
  ],
  content: { docA: "正文A，含密钥 ghp_" + "A".repeat(36), docB: "正文C" },
  exportCalls: 0,
});

const syncOpts = (commits) => ({
  pace: 0, sleepFn: async () => {}, now: () => "2026-06-10T00:00:00.000Z", workspace: "Team GDrive",
  commitFn: async (_dir, info) => { commits.push(info); return "sha-test"; },
});

// ---------- loadGoogle ----------
test("loadGoogle：缺文件 / 缺凭证 → null；内联凭证与 key_file 两条路都通；默认值生效", () => {
  const dir = mkdtempSync(join(tmpdir(), "gg-cfg-"));
  assert.equal(loadGoogle(join(dir, "nope.yaml")), null);
  writeFileSync(join(dir, "bad.yaml"), "poll_hours: 6\n");                   // 没凭证
  assert.equal(loadGoogle(join(dir, "bad.yaml")), null);

  // ① 内联
  writeFileSync(join(dir, "inline.yaml"), "client_email: sa@x.iam.gserviceaccount.com\nprivate_key: KEYDATA\n");
  const c1 = loadGoogle(join(dir, "inline.yaml"));
  assert.equal(c1.client_email, "sa@x.iam.gserviceaccount.com");
  assert.equal(c1.poll_hours, 4);                                           // 默认 4h
  assert.equal(c1.workspace, "google");                                     // 默认目录名

  // ② key_file 指向 service-account JSON
  writeFileSync(join(dir, "sa.json"), JSON.stringify({ client_email: "sa2@x.iam.gserviceaccount.com", private_key: "PEMDATA" }));
  writeFileSync(join(dir, "ext.yaml"), `key_file: ${join(dir, "sa.json")}\nworkspace: KB\n`);
  const c2 = loadGoogle(join(dir, "ext.yaml"));
  assert.equal(c2.client_email, "sa2@x.iam.gserviceaccount.com");
  assert.equal(c2.private_key, "PEMDATA");
  assert.equal(c2.workspace, "KB");
});

// ---------- withRetry ----------
test("withRetry：429/5xx 退避重试后成功；4xx 业务错误不重试", async () => {
  let n = 0;
  const flaky = async () => { if (++n < 3) throw Object.assign(new Error("503"), { status: 503 }); return "ok"; };
  assert.equal(await withRetry(flaky, { delays: [0, 0, 0], sleepFn: async () => {} }), "ok");
  assert.equal(n, 3);
  let tries = 0;
  const denied = async () => { tries++; throw Object.assign(new Error("404"), { status: 404 }); };
  await assert.rejects(() => withRetry(denied, { delays: [0, 0], sleepFn: async () => {} }), /404/);
  assert.equal(tries, 1);
});

// ---------- listDocs 分页 ----------
test("listDocs：翻页拼全（nextPageToken）", async () => {
  const pages = [
    { files: [doc("d1", "A")], nextPageToken: "p2" },
    { files: [doc("d2", "B")], nextPageToken: "" },
  ];
  let i = 0;
  const req = async (method, path) => {
    assert.equal(method, "GET");
    assert.match(path, /^\/files\?/);
    if (i === 1) assert.match(path, /pageToken=p2/);                        // 第二页带上一页游标
    return pages[i++];
  };
  const out = await listDocs(req);
  assert.deepEqual(out.map((d) => d.id), ["d1", "d2"]);
});

// ---------- renderDoc ----------
test("renderDoc：frontmatter 齐全 + 正文脱敏 + url", () => {
  const txt = renderDoc({
    collection: { id: "workspace", name: "Team GDrive" },
    node: { id: "docA", title: "PRD 主文档", modifiedTime: "2026-06-01T00:00:00.000Z", url: "https://docs.google.com/document/d/docA" },
    body: "密钥 ghp_" + "A".repeat(36),
    now: "2026-06-10T00:00:00.000Z",
  });
  assert.equal(fm(txt, "type"), "google-doc");
  assert.equal(fm(txt, "edited"), "2026-06-01T00:00:00.000Z");
  assert.equal(fm(txt, "workspace"), "Team GDrive");
  assert.equal(fm(txt, "doc_id"), "docA");
  assert.equal(fm(txt, "url"), "https://docs.google.com/document/d/docA");
  assert.match(txt, /\[REDACTED_GH\]/);
  assert.doesNotMatch(txt, /ghp_A/);
});

// ---------- sync 端到端 ----------
test("sync：首轮全写、export 拉正文脱敏、一轮一个 commit", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "gg-truth-"));
  const world = mkWorld(); const commits = [];
  const r = await syncGoogleDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.deepEqual([r.written, r.pruned, r.skipped, r.errors], [2, 0, 0, 0]);
  const dir = join(TRUTH, "google", "Team GDrive");
  assert.match(readFileSync(join(dir, "PRD 主文档--docA.md"), "utf8"), /\[REDACTED_GH\]/);
  assert.match(readFileSync(join(dir, "客户笔记--docB.md"), "utf8"), /正文C/);
  assert.equal(world.exportCalls, 2);
  assert.equal(commits.length, 1);
  assert.match(commits[0].message, /同步 2 篇/);
  assert.deepEqual(commits[0].paths, ["google"]);
  rmSync(TRUTH, { recursive: true, force: true });
});

test("sync 增量：modifiedTime 没变 → 不导出、不重写、不 commit；改一篇只重拉一篇", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "gg-truth-"));
  const world = mkWorld(); const commits = [];
  await syncGoogleDocs(TRUTH, fakeReq(world), syncOpts(commits));
  const r2 = await syncGoogleDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.deepEqual([r2.written, r2.skipped], [0, 2]);
  assert.equal(world.exportCalls, 2);                                       // 第二轮零次 export
  assert.equal(commits.length, 1);

  world.docs[1] = doc("docB", "客户笔记", { modified: "2026-06-09T00:00:00.000Z" });
  world.content.docB = "正文C v2";
  const r3 = await syncGoogleDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.deepEqual([r3.written, r3.skipped], [1, 1]);
  assert.match(readFileSync(join(TRUTH, "google", "Team GDrive", "客户笔记--docB.md"), "utf8"), /正文C v2/);
  rmSync(TRUTH, { recursive: true, force: true });
});

test("sync 孤儿清理 + 安全边界 + 路径红线", async () => {
  const TRUTH = mkdtempSync(join(tmpdir(), "gg-truth-"));
  const world = mkWorld(); const commits = [];
  await syncGoogleDocs(TRUTH, fakeReq(world), syncOpts(commits));
  const live = join(TRUTH, "google", "Team GDrive", "PRD 主文档--docA.md");

  // 孤儿清理：docB 没了 → 镜像删掉
  world.docs = [doc("docA", "PRD 主文档")];
  const r1 = await syncGoogleDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.equal(r1.pruned, 1);
  assert.ok(!existsSync(join(TRUTH, "google", "Team GDrive", "客户笔记--docB.md")));

  // list 失败 → 不清理
  world.failList = true;
  const r2 = await syncGoogleDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.equal(r2.errors, 1);
  assert.ok(existsSync(live));

  // 可见文档为空 → 整轮跳过且不删
  world.failList = false; world.docs = [];
  const r3 = await syncGoogleDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.equal(r3.errors, 1);
  assert.ok(existsSync(live));

  // 路径红线：doc id 含分隔符 → 跳过不落盘，其余照写
  world.docs = [doc("docA", "PRD 主文档"), doc("../evil", "恶意")];
  const r4 = await syncGoogleDocs(TRUTH, fakeReq(world), syncOpts(commits));
  assert.ok(r4.errors >= 1);
  assert.ok(!existsSync(join(TRUTH, "google", "Team GDrive", "恶意--../evil.md")));
  rmSync(TRUTH, { recursive: true, force: true });
});
