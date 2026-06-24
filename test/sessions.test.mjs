// 回归：把"user1 上周做了什么"漏检事故固化成断言。
// 复刻线上关键特征：
//   · 批量回填 → 所有 commit 都压在 2026-06-07（入库时间），与真实工作时间脱节；
//   · repo2 仓 owner 从 olduser2 搬到 Asklear → 文件落在 canonical(Asklear) 路径，但 commit subject 仍写旧 key(olduser2)；
//   · producer-id=user1（文件名前缀）与 git 提交者=username1 两套标识。
// 断言：① 查 user1 在 2026-06-01~07 的工作必须同时返回 repo1 + repo2；② user1 / username1 任一别名结果一致；
//      ③ 落在窗口外但"入库时间在窗口内"的旧 session 不能混进来；④ log 给的坐标能被 read（canonicalizePath）直接命中。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { sessionsTruth, logTruth } from "../server/query.mjs";
import { canonicalizePath } from "../core/identity.mjs";

const REG = {
  github: { orgs: [], repos: [] },
  moved: [
    { from: "olduser2/repo2", to: "Asklear/repo2" },
    { from: "olduser1/repo1", to: "Asklear/repo1" },
  ],
};
const ROSTER = { members: [{ id: "user1", name: "username1", git_names: ["username1", "user1"] }] };

const card = ({ space_key, branch, producer_id, submitter, date, updated, tool = "codex" }) =>
  `---\nid: x\ntool: ${tool}\nproducer: ${submitter}\nproducer_id: ${producer_id}\n` +
  `submitter: ${submitter}\nspace_key: ${space_key}\nbranch: ${branch}\n` +
  `date: ${date}\nupdated: ${updated}\n---\n# 帮我做点事\n这是正文预览。\n`;

// 铺一条 session 卡片并以"批量回填"的方式 commit（commit 时间统一 2026-06-07，与工作时间无关）。
function addSession(dir, { relPath, subject, author = "username1", ...fmFields }) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, card(fmFields));
  execFileSync("git", ["-C", dir, "add", "--", relPath]);
  execFileSync("git", ["-C", dir, "-c", `user.name=${author}`, "-c", `user.email=${author}@team-brain`,
    "commit", "-q", "-m", subject, "--author", `${author} <${author}@team-brain>`], {
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-06-07T15:24:00", GIT_COMMITTER_DATE: "2026-06-07T15:24:00" },
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tb-sessions-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  // 1) repo2 上周那条：工作时间 2026-06-01（事故中被漏掉的那条）。
  //    文件落在 canonical(Asklear) 路径，但 commit subject 仍是旧 owner(olduser2) —— 复刻坐标不一致。
  addSession(dir, {
    relPath: "spaces/github__Asklear__repo2/sessions/main/user1-rollout-2026-06-01T01-06-12-019e7f00.md",
    subject: "ingest github__olduser2__repo2/main/user1-rollout-2026-06-01T01-06-12-019e7f00",
    space_key: "github__Asklear__repo2", branch: "main", producer_id: "user1", submitter: "username1",
    date: "2026-06-01T01:06:12.000Z", updated: "2026-06-01T02:30:00.000Z",
  });
  // 2) repo1 上周那条：会话 2026-05-17 起、末次活动 2026-06-05（跨进窗口）。subject 旧 owner(olduser1)。
  addSession(dir, {
    relPath: "spaces/github__Asklear__repo1/sessions/etl-node-first-on-spec022/user1-rollout-2026-05-17T17-34-51-019e3549.md",
    subject: "ingest github__olduser1__repo1/etl-node-first-on-spec022/user1-rollout-2026-05-17T17-34-51-019e3549",
    space_key: "github__Asklear__repo1", branch: "etl-node-first-on-spec022", producer_id: "user1", submitter: "username1",
    date: "2026-05-17T17:34:51.000Z", updated: "2026-06-05T10:00:00.000Z",
  });
  // 3) 干扰项：user1 的 repo2 旧会话，工作时间 2026-04-26，但同样在 06-07 入库 →
  //    若按入库时间(log+since)查"上周"会误纳；按工作时间(sessions)必须排除。
  addSession(dir, {
    relPath: "spaces/github__Asklear__repo2/sessions/main/user1-rollout-2026-04-26T09-20-00-019dc75f.md",
    subject: "ingest github__olduser2__repo2/main/user1-rollout-2026-04-26T09-20-00-019dc75f",
    space_key: "github__Asklear__repo2", branch: "main", producer_id: "user1", submitter: "username1",
    date: "2026-04-26T09:20:00.000Z", updated: "2026-04-26T11:00:00.000Z",
  });
  return dir;
}

const TRUTH = fixture();
const paths = (r) => r.sessions.map((s) => s.path).sort();

test("事故核心：查 user1 2026-06-01~07 的工作，repo1 + repo2 两条都在", async () => {
  const r = await sessionsTruth(TRUTH, { author: "user1", since: "2026-06-01", until: "2026-06-07", roster: ROSTER, registry: REG });
  const spaces = r.sessions.map((s) => s.space_key).sort();
  assert.deepEqual(spaces, ["github__Asklear__repo1", "github__Asklear__repo2"]);
  assert.equal(r.sessions.length, 2);
});

test("别名一致：author=user1 与 author=username1 结果完全一致", async () => {
  const a = await sessionsTruth(TRUTH, { author: "user1", since: "2026-06-01", until: "2026-06-07", roster: ROSTER, registry: REG });
  const b = await sessionsTruth(TRUTH, { author: "username1", since: "2026-06-01", until: "2026-06-07", roster: ROSTER, registry: REG });
  assert.deepEqual(paths(a), paths(b));
  assert.equal(a.sessions.length, 2);
});

test("工作时间≠入库时间：04-26 的旧会话虽 06-07 入库，也不混进上周窗口", async () => {
  const r = await sessionsTruth(TRUTH, { author: "user1", since: "2026-06-01", until: "2026-06-07", roster: ROSTER, registry: REG });
  assert.ok(!r.sessions.some((s) => s.path.includes("2026-04-26")), "04-26 旧会话不应出现");
});

test("返回带两种时间，且坐标 canonical（space_key 已是现位置）", async () => {
  // ingest_date 现为按需（贵：每条一次 git log）→ 显式 withIngestDate 才带
  const r = await sessionsTruth(TRUTH, { author: "user1", since: "2026-06-01", until: "2026-06-07", withIngestDate: true, roster: ROSTER, registry: REG });
  for (const s of r.sessions) {
    assert.match(s.space_key, /^github__Asklear__/);       // 不再有 olduser2/olduser1
    assert.ok(s.work_start && s.work_end, "带工作时间");
    assert.ok(s.ingest_date, "带入库时间");
  }
});

test("默认不带 ingest_date（性能：跳过每条 git log）", async () => {
  const r = await sessionsTruth(TRUTH, { author: "user1", roster: ROSTER, registry: REG });
  for (const s of r.sessions) assert.equal(s.ingest_date, undefined);
});

test("log 坐标归一：subject 里的 olduser2/olduser1 被改写成 Asklear", async () => {
  const commits = await logTruth(TRUTH, { author: "username1", limit: 10, registry: REG });
  const subjects = commits.map((c) => c.subject).join("\n");
  assert.ok(!/olduser2|olduser1/.test(subjects), "log 输出坐标不应再含历史 owner");
  assert.match(subjects, /github__Asklear__repo2/);
});

test("坐标可消费：log/旧坐标经 canonicalizePath 后能定位到真实文件（消除 404）", () => {
  // 模拟 agent 抄了 log 给的旧坐标
  const stale = "spaces/github__olduser2__repo2/sessions/main/user1-rollout-2026-06-01T01-06-12-019e7f00.md";
  const canon = canonicalizePath(REG, stale);
  assert.ok(existsSync(join(TRUTH, canon)), "归一后的坐标必须命中真实文件");
  assert.match(readFileSync(join(TRUTH, canon), "utf8"), /space_key: github__Asklear__repo2/);
});

test("空 author/窗口：sessions 不因缺参崩", async () => {
  const r = await sessionsTruth(TRUTH, { roster: ROSTER, registry: REG });
  assert.equal(r.sessions.length, 3);                       // 全量 3 条
});
