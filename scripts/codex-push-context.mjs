import {
  ensureBridgeServer,
  findRememberedSession,
  parseMaybeJson,
  request
} from "./memory-runtime.mjs";

async function main() {
  const firstArg = process.argv[2]?.trim() ?? "";
  const secondArg = process.argv[3]?.trim() ?? "";
  const replace = process.argv.includes("--replace");

  const remembered = findRememberedSession(firstArg);
  const sessionId = remembered?.sessionId ?? remembered?.bridgeId ?? firstArg;
  const payload = remembered ? secondArg : process.argv.slice(3).join(" ").trim();

  if (!sessionId) {
    console.error("缺少 sessionId。用法：npm run codex:push-context -- \"sessionId\" \"补充上下文\"");
    process.exit(1);
  }

  if (!payload) {
    console.error("缺少上下文内容。你总不能让桥服务猜心思。");
    process.exit(1);
  }

  const bridgeServerUrl = await ensureBridgeServer();
  const parsed = parseMaybeJson(payload);
  const entries = Array.isArray(parsed) ? parsed : [parsed ?? payload];

  const response = await request(`${bridgeServerUrl}/api/memory/context`, {
    method: "POST",
    body: {
      sessionId,
      entries,
      replace
    },
    timeout: 5000
  });

  if (!response.ok) {
    throw new Error(response.json?.error ?? "推送上下文失败");
  }

  process.stdout.write(`${JSON.stringify(response.json, null, 2)}\n`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
