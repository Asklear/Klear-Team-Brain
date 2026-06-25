// Google Docs 只读镜像（Drive + export，原生 fetch + node:crypto 自签 JWT，无 googleapis SDK）。
// 凭证 = 一个 service account；把文档/文件夹 share 给它的邮箱才可见（同 Notion 的"share 给 integration"）。
// 正文走 Drive export 到 text/plain：一次拿全文，免解析 Docs 结构。增量靠 Drive 的 modifiedTime（已是 RFC3339 ISO）。
import { readFileSync, existsSync } from "node:fs";
import { createSign } from "node:crypto";
import { parse } from "yaml";
import { sleep, withRetry } from "./retry.mjs";

export { sleep, withRetry };

const DRIVE = "https://www.googleapis.com/drive/v3";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

// google.yaml（服务器级、gitignore、启动加载 restart 生效）。缺文件/解析失败/没配齐凭证 → null = Google 层不启用。
// 凭证两种给法：① key_file 指向下载的 service-account JSON；② 直接内联 client_email + private_key。
export function loadGoogle(path) {
  if (!existsSync(path)) return null;
  let cfg;
  try { cfg = parse(readFileSync(path, "utf8")) || {}; } catch { return null; }
  let client_email = cfg.client_email, private_key = cfg.private_key;
  if (cfg.key_file) {
    try { const k = JSON.parse(readFileSync(cfg.key_file, "utf8")); client_email = k.client_email; private_key = k.private_key; }
    catch { return null; }
  }
  if (!client_email || !private_key) return null;
  return {
    client_email: String(client_email),
    private_key: String(private_key),
    poll_hours: Number(cfg.poll_hours) || 4,
    workspace: String(cfg.workspace || "google"),   // 真相库 google/ 下的目录名（自己起）
  };
}

// service-account JWT → assertion（RS256 签名走 node:crypto，免 SDK）。
function signJwt({ client_email, private_key }) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const head = { alg: "RS256", typ: "JWT" };
  const claim = { iss: client_email, scope: SCOPE, aud: TOKEN_URI, iat, exp: iat + 3600 };
  const body = `${enc(head)}.${enc(claim)}`;
  const sig = createSign("RSA-SHA256").update(body).end().sign(private_key).toString("base64url");
  return `${body}.${sig}`;
}

// 用 JWT 换 access_token（OAuth2 jwt-bearer 流）。
export async function fetchToken(cfg) {
  const r = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signJwt(cfg) }),
  });
  if (!r.ok) throw Object.assign(new Error(`Google token ${r.status}: ${(await r.text()).slice(0, 120)}`), { status: r.status });
  return r.json();   // { access_token, expires_in, token_type }
}

// 认证请求口：缓存 access_token（~1h），到期前 60s 刷新；req(method, path, {raw}) → json 或纯文本。
// path 以 / 开头时相对 Drive v3；完整 http 原样用。非 2xx 抛带 .status 的错误（供 withRetry 判重试）。
export function makeReq(cfg, retryOpts = {}) {
  let tok = null, exp = 0;
  const auth = async () => {
    if (tok && Date.now() < exp - 60000) return tok;
    const t = await fetchToken(cfg);
    tok = t.access_token; exp = Date.now() + (Number(t.expires_in) || 3600) * 1000;
    return tok;
  };
  return (method, path, { raw = false } = {}) => withRetry(async () => {
    const token = await auth();
    const r = await fetch(path.startsWith("http") ? path : DRIVE + path, { method, headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw Object.assign(new Error(`Google ${r.status} on ${path}: ${(await r.text()).slice(0, 120)}`), { status: r.status });
    return raw ? r.text() : r.json();
  }, retryOpts);
}

// 列出 service account 可见的全部 Google 文档（分页）。归一为 [{id,name,modifiedTime,webViewLink}]。
export async function listDocs(req) {
  const out = [];
  const q = "mimeType='application/vnd.google-apps.document' and trashed=false";
  const fields = "nextPageToken,files(id,name,modifiedTime,webViewLink)";
  let pageToken = "";
  do {
    const qs = new URLSearchParams({ q, fields, pageSize: "100", ...(pageToken ? { pageToken } : {}) });
    const r = await req("GET", `/files?${qs}`);
    out.push(...(r?.files || []));
    pageToken = r?.nextPageToken || "";
  } while (pageToken);
  return out;
}

// 导出某文档为纯文本（Drive export，一次拿全文，免解析 Docs 结构）。
export const exportDocText = (req, id) => req("GET", `/files/${id}/export?mimeType=text/plain`, { raw: true });
