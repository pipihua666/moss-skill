import {
  ensureBridgeServer,
  findRememberedSession,
  request
} from "./memory-runtime.mjs";

async function main() {
  const firstArg = process.argv[2]?.trim() ?? "";
  const remembered = findRememberedSession(firstArg);
  const sessionId = remembered?.sessionId ?? remembered?.bridgeId ?? firstArg;

  if (!sessionId) {
    console.error("缺少 sessionId。用法：npm run codex:read-events -- \"sessionId\" --after 12");
    process.exit(1);
  }

  const afterFlagIndex = process.argv.findIndex((item) => item === "--after");
  const after = afterFlagIndex >= 0 ? Number(process.argv[afterFlagIndex + 1] ?? 0) : 0;
  const includeHostEvents = process.argv.includes("--include-host");
  const bridgeServerUrl = await ensureBridgeServer();
  const url = new URL("/api/bridge/events", bridgeServerUrl);

  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("after", String(Number.isFinite(after) ? after : 0));
  if (!includeHostEvents) {
    url.searchParams.set("excludeSource", "codex-host");
  }

  const response = await request(url.toString(), {
    timeout: 5000
  });

  if (!response.ok) {
    throw new Error(response.json?.error ?? "读取桥事件失败");
  }

  const filtered = includeHostEvents
    ? response.json
    : {
        ...response.json,
        events: (response.json?.events ?? []).filter((event) => event.source !== "bridge-server")
      };

  process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
