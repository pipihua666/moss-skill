import {
  ensureBridgeServer,
  findRememberedSession,
  request,
  updateRememberedSession
} from "./memory-runtime.mjs";

function parseArgs(argv) {
  const result = {
    positionals: [],
    replace: false,
    includeHostEvents: false,
    noMarkRead: false,
    after: null
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--replace") {
      result.replace = true;
      continue;
    }

    if (current === "--include-host") {
      result.includeHostEvents = true;
      continue;
    }

    if (current === "--no-mark-read") {
      result.noMarkRead = true;
      continue;
    }

    if (current === "--after") {
      result.after = Number(argv[index + 1] ?? 0);
      index += 1;
      continue;
    }

    result.positionals.push(current);
  }

  return result;
}

function summarizeEvent(event) {
  switch (event.type) {
    case "bridge:ready":
      return "网页虚拟人已连上桥，算是正式报到。";
    case "bridge:request-context":
      return `网页请求最新上下文：${event.payload?.reason ?? "未说明原因"}`;
    case "bridge:user-message":
      return `网页用户输入：${event.payload?.text ?? ""}`;
    case "bridge:persona-message":
      return `网页虚拟人回复：${event.payload?.text ?? ""}`;
    case "bridge:status":
      return `网页状态：${event.payload?.state ?? "unknown"}${event.payload?.detail ? ` (${event.payload.detail})` : ""}`;
    case "bridge:context-update":
      return `网页上下文已更新 ${Array.isArray(event.payload?.entries) ? event.payload.entries.length : 0} 条。`;
    default:
      return `网页发来事件：${event.type}`;
  }
}

function simplifyEvent(event) {
  return {
    eventId: Number(event.eventId ?? 0),
    type: event.type,
    source: event.source ?? "unknown",
    timestamp: Number(event.timestamp ?? Date.now()),
    summary: summarizeEvent(event),
    payload: event.payload ?? null
  };
}

async function main() {
  const parsed = parseArgs(process.argv);
  const identifier = parsed.positionals[0]?.trim() ?? "";
  const payload = parsed.positionals.slice(1).join(" ").trim();
  const remembered = findRememberedSession(identifier);
  const sessionId = remembered?.sessionId ?? remembered?.bridgeId ?? identifier;
  const after = Number.isFinite(parsed.after) && parsed.after !== null
    ? Number(parsed.after)
    : Number(remembered?.lastReadEventId ?? 0);

  if (!sessionId) {
    console.error("缺少人物名称或 sessionId。用法：npm run codex:sync-events -- \"奶奶\" \"当前触发消息\"");
    process.exit(1);
  }

  const bridgeServerUrl = await ensureBridgeServer();
  const syncResponse = await request(`${bridgeServerUrl}/api/memory/sync`, {
    method: "POST",
    body: {
      sessionId,
      prompt: payload,
      replace: parsed.replace,
      includeHostEvents: parsed.includeHostEvents,
      after
    },
    timeout: 120000
  });

  if (!syncResponse.ok && !syncResponse.json) {
    throw new Error("同步人物回忆失败");
  }

  if (!syncResponse.ok && syncResponse.json?.appError) {
    throw new Error(syncResponse.json.appError);
  }

  if (!syncResponse.ok) {
    throw new Error(syncResponse.json?.error ?? "同步人物回忆失败");
  }

  const unreadEvents = (syncResponse.json?.unreadEvents ?? []).map((event) => {
    const bridgeType = event.type === "session.started"
      ? "bridge:ready"
      : event.type === "context.updated"
        ? "bridge:context-update"
        : event.type === "user.message"
          ? "bridge:user-message"
          : event.type === "persona.message"
            ? "bridge:persona-message"
            : event.type === "status.changed"
              ? "bridge:status"
              : "bridge:request-context";

    return simplifyEvent({
      ...event,
      type: bridgeType
    });
  });

  const nextCursor = Number(syncResponse.json?.nextCursor ?? after);

  if (!parsed.noMarkRead) {
    updateRememberedSession(identifier || sessionId, {
      lastReadEventId: nextCursor,
      updatedAt: Date.now()
    });
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    sessionId,
    bridgeId: sessionId,
    personId: remembered?.personId ?? null,
    unreadCount: unreadEvents.length,
    unreadEvents,
    promptContext: syncResponse.json?.promptContext ?? unreadEvents.map((event) => event.summary),
    pushed: Boolean(syncResponse.json?.pushed),
    pushedCount: Number(syncResponse.json?.pushedCount ?? 0),
    contextCount: Number(syncResponse.json?.contextCount ?? 0),
    contextEventId: Number(syncResponse.json?.contextEventId ?? 0),
    previousCursor: after,
    nextCursor,
    markedRead: !parsed.noMarkRead,
    appReply: syncResponse.json?.appReply ?? null,
    turnId: syncResponse.json?.turnId ?? null,
    threadId: syncResponse.json?.threadId ?? null
  }, null, 2)}\n`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
