// provider 分发：把 github/gitlab/gitea 三家归一化客户端按 provider 选出来，并从 registry 解出
// 调用上下文（token + baseUrl）。codestate 轮询、enum 预登记、/github 现拉都经这里，调用方不认 provider 细节。
import * as github from "./github.mjs";
import * as gitlab from "./gitlab.mjs";
import * as gitea from "./gitea.mjs";
import { instanceFor, tokenFor, baseUrlOf } from "./registry.mjs";

const CLIENTS = { github, gitlab, gitea };

export function clientFor(provider) {
  return CLIENTS[provider] || null;
}

// 解出某 space 该用的 { token, baseUrl }。token 永远来自 registry（密钥不落 space.yaml）；
// baseUrl：github 用默认（undefined）；gitlab/gitea 优先用实例配置，回退 space 存的 base_url / https://host。
export function ctxFor(registry, { provider, host, owner, repo, base_url } = {}, fallbackToken = "") {
  const token = tokenFor(registry, { provider, host, owner, repo }, fallbackToken);
  if (provider === "github") return { token };
  const inst = instanceFor(registry, provider, host);
  const baseUrl = baseUrlOf(inst) || base_url || (host ? `https://${host}` : "");   // 实例配置优先，回退 space 存的 base_url / https://host
  return { token, baseUrl };
}
