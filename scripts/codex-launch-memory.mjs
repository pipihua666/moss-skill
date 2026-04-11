import {
  ensureAvatarServer,
  ensureBridgeServer,
  findRememberedSession,
  openBrowser,
  rememberSession,
  request
} from "./memory-runtime.mjs";

async function main() {
  const personId = process.argv[2]?.trim();
  const initialContext = process.argv.slice(3).join(" ").trim();

  if (!personId) {
    console.error("缺少人物名称。用法：npm run codex:launch -- \"奶奶\" \"当前触发消息\"");
    process.exit(1);
  }

  await ensureAvatarServer();
  const bridgeServerUrl = await ensureBridgeServer();
  const remembered = findRememberedSession(personId);
  const sessionId = remembered?.sessionId ?? remembered?.bridgeId;

  const launchResponse = await request(`${bridgeServerUrl}/api/memory/launch`, {
    method: "POST",
    body: {
      personId,
      sessionId,
      context: initialContext ? [initialContext] : []
    },
    timeout: 5000
  });

  if (!launchResponse.ok || !launchResponse.json?.sessionId) {
    throw new Error(launchResponse.json?.error ?? "启动记忆会话失败");
  }

  const result = {
    ...launchResponse.json,
    opened: false
  };

  if (!launchResponse.json.reused || Number(launchResponse.json.streamCount ?? 0) === 0) {
    const browser = openBrowser(launchResponse.json.avatarUrl);

    result.opened = true;
    await new Promise((resolve) => {
      browser.on("error", () => {
        result.opened = false;
        resolve();
      });
      browser.on("spawn", () => resolve());
    });

    browser.unref?.();
  }

  rememberSession({
    personId,
    sessionId: launchResponse.json.sessionId,
    bridgeId: launchResponse.json.sessionId,
    avatarUrl: launchResponse.json.avatarUrl,
    bridgeServerUrl,
    threadId: launchResponse.json.threadId ?? null,
    updatedAt: Date.now()
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
