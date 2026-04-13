import { loadMemoryIndex, loadPersonProfile } from "../data/memoryLoader";
import { SpeechController, startVoiceSession, stopVoiceSession } from "../voice/speech";
import type {
  MemoryIndex,
  PersonProfile,
  SharedContextEntry,
  VoiceSessionState
} from "../types";

const DEFAULT_SERVER_URL = "http://127.0.0.1:4174";

type ThreadMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  pending?: boolean;
  source?: string | null;
  turnId?: string | null;
  createdAt: number;
};

type ThreadSummary = {
  threadId: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  lastError?: string | null;
  messageCount: number;
  contextCount: number;
};

type ThreadRecord = ThreadSummary & {
  messages: ThreadMessage[];
  contextEntries: SharedContextEntry[];
};

type WorkspaceRecord = {
  sessionId: string;
  bridgeId?: string;
  personId: string;
  createdAt: number;
  updatedAt: number;
  currentThreadId: string | null;
  threadId?: string | null;
  threads: ThreadSummary[];
  threadCount: number;
};

type RpcResponse<T> = {
  result?: T;
  error?: {
    message?: string;
  };
};

type NotificationEvent = {
  type: string;
  sessionId: string;
  personId: string;
  threadId?: string;
  atIso: string;
  payload?: Record<string, unknown>;
};

type ConsoleState = {
  profile: PersonProfile;
  serverUrl: string;
  workspace: WorkspaceRecord | null;
  currentThread: ThreadRecord | null;
  transport: "connecting" | "ws" | "sse" | "offline";
  memoryPanelOpen: boolean;
  sending: boolean;
  voiceState: VoiceSessionState;
  voiceDetail: string;
  liveTranscript: string;
  captureMode: "keyboard" | "pointer" | null;
};

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }

  return null;
}

function describeRequestFailure(url: string, status: number, payload: unknown): string {
  if (status === 404 && url.includes("/codex-api/")) {
    let path = "/codex-api";

    try {
      path = new URL(url).pathname;
    } catch {
      // URL 解析失败时保底给个固定说明，别把报错再报错。
    }

    return `当前连接到的本地桥服务版本过旧，不支持 ${path}。请先结束旧的 4174 桥服务，再重新唤起页面。`;
  }

  return extractErrorMessage(payload) ?? `请求失败：${status}`;
}

function getSearchParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function getQueryPerson(): string | null {
  return getSearchParams().get("person");
}

function getQuerySessionId(): string | null {
  const search = getSearchParams();
  return search.get("session") ?? search.get("bridge");
}

function getQueryThreadId(): string | null {
  return getSearchParams().get("thread");
}

function getQueryServerUrl(): string {
  const search = getSearchParams();
  return (search.get("server") ?? search.get("bridgeServer") ?? DEFAULT_SERVER_URL).replace(/\/$/, "");
}

function updateUrlState(personId: string, sessionId: string, threadId: string | null, serverUrl: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("person", personId);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("bridge", sessionId);
  url.searchParams.set("server", serverUrl);
  url.searchParams.set("bridgeServer", serverUrl);

  if (threadId) {
    url.searchParams.set("thread", threadId);
  } else {
    url.searchParams.delete("thread");
  }

  window.history.replaceState({}, "", url);
}

function normalizeContextEntries(input: string | string[] | undefined, source = "browser-host"): SharedContextEntry[] {
  if (!input) {
    return [];
  }

  const values = Array.isArray(input) ? input : [input];
  return values
    .map((text) => String(text).trim())
    .filter(Boolean)
    .map((text) => ({
      id: createId(source),
      source,
      text,
      timestamp: Date.now()
    }));
}

function formatContextSource(source: string): string {
  return source.replace(/[-_]/g, " ").trim() || "agent";
}

function displayValue(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 && normalized !== "待确认" ? normalized : fallback;
}

function firstKnown(values: Array<string | undefined>, fallback: string): string {
  for (const value of values) {
    const normalized = (value ?? "").replace(/\s+/g, " ").trim();
    if (normalized.length > 0 && normalized !== "待确认") {
      return normalized;
    }
  }

  return fallback;
}

function getPersonaLabel(profile: PersonProfile): string {
  return firstKnown(
    [profile.howUserRefersToThem, profile.aliases[0], profile.name],
    "TA"
  );
}

function voiceLabel(state: VoiceSessionState): string {
  switch (state) {
    case "idle":
      return "IDLE";
    case "requesting-permission":
      return "REQUESTING";
    case "listening":
      return "LISTENING...";
    case "processing":
      return "PROCESSING...";
    case "speaking":
      return "SPEAKING";
    case "unsupported":
      return "UNSUPPORTED";
    case "error":
      return "ERROR";
    default:
      return "IDLE";
  }
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit"
  }).format(timestamp);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === "textarea" || tagName === "input" || tagName === "select";
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(describeRequestFailure(url, response.status, payload));
  }

  return payload as T;
}

async function rpcCall<T>(serverUrl: string, method: string, params?: unknown): Promise<T> {
  const payload = await postJson<RpcResponse<T>>(`${serverUrl}/codex-api/rpc`, {
    method,
    params: params ?? null
  });

  if (payload.error?.message) {
    throw new Error(payload.error.message);
  }

  if (payload.result === undefined) {
    throw new Error(`RPC ${method} 没返回结果，像把回信塞进了下水道。`);
  }

  return payload.result;
}

function buildLaunchUrl(
  personId: string,
  options?: {
    sessionId?: string;
    bridgeId?: string;
    threadId?: string;
    serverUrl?: string;
    bridgeServerUrl?: string;
  }
): URL {
  const url = new URL(window.location.href);
  const sessionId = options?.sessionId ?? options?.bridgeId ?? crypto.randomUUID();
  const serverUrl = (options?.serverUrl ?? options?.bridgeServerUrl ?? DEFAULT_SERVER_URL).replace(/\/$/, "");

  url.searchParams.set("person", personId);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("bridge", sessionId);
  url.searchParams.set("server", serverUrl);
  url.searchParams.set("bridgeServer", serverUrl);

  if (options?.threadId) {
    url.searchParams.set("thread", options.threadId);
  } else {
    url.searchParams.delete("thread");
  }

  return url;
}

async function requestBridgeLaunch(
  serverUrl: string,
  payload: {
    personId: string;
    sessionId?: string;
    bridgeId?: string;
    threadId?: string;
    context?: string | string[];
  }
): Promise<{ avatarUrl: string; sessionId: string; threadId: string }> {
  return postJson(`${serverUrl.replace(/\/$/, "")}/api/memory/launch`, {
    personId: payload.personId,
    sessionId: payload.sessionId ?? payload.bridgeId,
    threadId: payload.threadId,
    context: payload.context ? (Array.isArray(payload.context) ? payload.context : [payload.context]) : []
  });
}

export function launchMemoryUser(
  personId: string,
  options?: {
    sessionId?: string;
    bridgeId?: string;
    threadId?: string;
    context?: string | string[];
    serverUrl?: string;
    bridgeServerUrl?: string;
  }
): void {
  const preferredServer = (options?.serverUrl ?? options?.bridgeServerUrl ?? DEFAULT_SERVER_URL).replace(/\/$/, "");
  const placeholder = window.open("about:blank", "_blank", "noopener,noreferrer");

  void requestBridgeLaunch(preferredServer, {
    personId,
    sessionId: options?.sessionId ?? options?.bridgeId,
    threadId: options?.threadId,
    context: options?.context
  }).then((data) => {
    if (placeholder) {
      placeholder.location.href = data.avatarUrl;
      return;
    }

    window.location.href = data.avatarUrl;
  }).catch(() => {
    const directUrl = buildLaunchUrl(personId, options);
    if (placeholder) {
      placeholder.location.href = directUrl.toString();
      return;
    }

    window.location.href = directUrl.toString();
  });
}

function renderShell(container: HTMLElement, content: HTMLElement): void {
  container.innerHTML = "";
  const shell = document.createElement("div");
  shell.className = "app-shell";
  shell.append(content);
  container.append(shell);
}

function renderHome(container: HTMLElement, people: MemoryIndex[]): void {
  const page = document.createElement("main");
  page.className = "home-page";

  const featured = people[0];
  page.innerHTML = `
    <section class="hero-panel hero-panel-axa">
      <div class="hero-copy">
        <p class="hero-kicker">AXA // Synthetic Oracle</p>
        <h1>
          <span class="hero-title-lead">让回忆不只会站着发呆</span>
          <span class="hero-title-accent">也能像终端一样实时回应。</span>
        </h1>
        <p class="hero-text">当前版本把人物页重构成赛博语音控制台。你先选一个人，后面线程、上下文、语音和本地 Codex 都会继续在同一块 HUD 里干活，不再像几个零件临时拼桌吃饭。</p>
        <div class="hero-actions">
          ${featured ? `<button type="button" class="primary-btn" data-role="open-person" data-person="${featured.name}">唤起 ${featured.name}</button>` : ""}
          <button type="button" class="ghost-btn" data-role="reload-home">刷新档案</button>
        </div>
      </div>
      <div class="hero-meter">
        <article>
          <span>人物档案</span>
          <strong>${people.length}</strong>
          <p>全部来自 <code>references/</code> 的记忆库。</p>
        </article>
        <article>
          <span>控制方式</span>
          <strong>Bridge Synced</strong>
          <p>桥服务和页面分层工作，不让浏览器直接裸奔碰 Codex。</p>
        </article>
        <article class="hero-meter-visual">
          <span>ACTIVE STATE</span>
          <strong>Voice + Thread</strong>
          <p>按住说话、切线程、带上下文，终于不像一张会发光的壁纸。</p>
        </article>
      </div>
    </section>
    <section class="persona-gallery">
      <div class="gallery-head">
        <div>
          <p class="hero-kicker">Available Personas</p>
          <h2>已经写进记忆库的人</h2>
        </div>
        <p>点任何一张卡片都会直接进入人物控制台。页面会自动尝试接上本地记忆桥，省得你每次都像在机房里手拧法兰。</p>
      </div>
      <div class="persona-grid" data-role="persona-grid"></div>
    </section>
  `;

  const grid = page.querySelector<HTMLElement>("[data-role='persona-grid']");
  if (!grid) {
    throw new Error("首页人物卡片容器失踪了，像把通讯录丢进了回收站。");
  }

  if (people.length === 0) {
    const emptyCard = document.createElement("article");
    emptyCard.className = "persona-card persona-card-empty";
    emptyCard.innerHTML = `
      <p class="persona-label">No Persona Yet</p>
      <h3>还没有人物档案</h3>
      <p>先去补充 <code>references/</code> 下的回忆文件，控制台现在像一间刚装修好但没住人的公寓。</p>
    `;
    grid.append(emptyCard);
  }

  people.forEach((person, index) => {
    const card = document.createElement("article");
    card.className = "persona-card";
    card.innerHTML = `
      <div class="persona-card-topline">
        <span class="persona-label">${displayValue(person.relationship, "重要的人")}</span>
        <strong>#${String(index + 1).padStart(2, "0")}</strong>
      </div>
      <div class="persona-card-head">
        <h3>${person.name}</h3>
        <p>${displayValue(person.status, "可唤起")}</p>
      </div>
      <div class="persona-tag-row">
        ${(person.aliases.length > 0 ? person.aliases : [person.name])
          .slice(0, 3)
          .map((alias) => `<span>${alias}</span>`)
          .join("")}
      </div>
      <p class="persona-card-copy">进入后会看到线程侧栏、主对话区和可折叠虚拟人浮层。终于不是“机器人一只、文本框一个、剩下全靠脑补”了。</p>
      <div class="persona-card-foot">
        <span>最近更新：${displayValue(person.lastUpdated, "未记录")}</span>
        <button type="button" class="primary-btn" data-role="open-person" data-person="${person.name}">打开控制台</button>
      </div>
    `;
    grid.append(card);
  });

  page.querySelectorAll<HTMLElement>("[data-role='open-person']").forEach((button) => {
    button.addEventListener("click", () => {
      const personName = button.dataset.person;
      if (personName) {
        launchMemoryUser(personName);
      }
    });
  });

  page.querySelector<HTMLElement>("[data-role='reload-home']")?.addEventListener("click", () => {
    window.location.reload();
  });

  renderShell(container, page);
}

function upsertThreadSummary(threads: ThreadSummary[], nextThread: ThreadSummary): ThreadSummary[] {
  const list = [...threads];
  const index = list.findIndex((thread) => thread.threadId === nextThread.threadId);

  if (index >= 0) {
    list[index] = nextThread;
  } else {
    list.push(nextThread);
  }

  return list.sort((left, right) => right.updatedAt - left.updatedAt);
}

function upsertThreadMessage(messages: ThreadMessage[], nextMessage: ThreadMessage): ThreadMessage[] {
  const list = [...messages];
  const index = list.findIndex((message) => message.id === nextMessage.id);

  if (index >= 0) {
    list[index] = nextMessage;
  } else {
    list.push(nextMessage);
  }

  return list.sort((left, right) => left.createdAt - right.createdAt);
}

function createRealtimeTransport(
  serverUrl: string,
  sessionId: string,
  onEvent: (event: NotificationEvent) => void,
  onTransportChange: (transport: "connecting" | "ws" | "sse" | "offline") => void
): () => void {
  let closed = false;
  let cleanup: (() => void) | null = null;
  let reconnectTimer: number | null = null;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) {
      return;
    }

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      attachWebSocket();
    }, 1500);
  };

  const attachSse = () => {
    if (closed) {
      return;
    }

    cleanup?.();
    const source = new EventSource(`${serverUrl}/codex-api/events?sessionId=${encodeURIComponent(sessionId)}`);
    onTransportChange("connecting");

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as NotificationEvent;
        if (payload.type === "transport.ready") {
          onTransportChange("sse");
        }
        onEvent(payload);
      } catch {
        // SSE 里偶发坏数据时，丢掉就行，别把页面一块带进河里。
      }
    };

    source.onerror = () => {
      onTransportChange("offline");
      source.close();
      scheduleReconnect();
    };

    cleanup = () => {
      source.close();
    };
  };

  const attachWebSocket = () => {
    if (closed) {
      return;
    }

    cleanup?.();
    onTransportChange("connecting");

    const protocol = serverUrl.startsWith("https:") ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${serverUrl.replace(/^https?:\/\//, "")}/codex-api/ws?sessionId=${encodeURIComponent(sessionId)}`);
    let opened = false;
    let fallbackTimer: number | null = window.setTimeout(() => {
      if (opened || closed) {
        return;
      }

      socket.close();
      attachSse();
    }, 2200);

    socket.onopen = () => {
      opened = true;
      onTransportChange("ws");
      clearReconnectTimer();
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as NotificationEvent;
        if (payload.type === "transport.ready") {
          onTransportChange("ws");
        }
        onEvent(payload);
      } catch {
        // WebSocket 偶发坏包时忽略，不要演成灾难片。
      }
    };

    socket.onerror = () => {
      onTransportChange("offline");
    };

    socket.onclose = () => {
      if (closed) {
        return;
      }

      onTransportChange("offline");
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      attachSse();
    };

    cleanup = () => {
      socket.close();
    };
  };

  attachWebSocket();

  return () => {
    closed = true;
    clearReconnectTimer();
    cleanup?.();
  };
}

async function renderConsole(container: HTMLElement, profile: PersonProfile): Promise<void> {
  const state: ConsoleState = {
    profile,
    serverUrl: getQueryServerUrl(),
    workspace: null,
    currentThread: null,
    transport: "connecting",
    memoryPanelOpen: true,
    sending: false,
    voiceState: "idle",
    voiceDetail: "按住空格或按钮收音，也可以直接打字。",
    liveTranscript: "本地 Codex 正在待命。你说一句，它就得认真接一句，装睡也没用。",
    captureMode: null
  };

  const personaLabel = getPersonaLabel(profile);
  const catchphrase = firstKnown(
    [profile.speakingStyle.catchphrases[0], profile.speakingStyle.commonWords[0]],
    `${personaLabel}在这儿`
  );
  const careText = displayValue(profile.behaviorStyle.showCare, `${personaLabel}会先听你把话说完。`);
  const memoryScene = firstKnown(
    [profile.keyMemories.memorableScene, profile.keyMemories.smallDetails],
    "代表性回忆还没补全。"
  );
  const detailAnchor = firstKnown(
    [profile.keyMemories.smallDetails, profile.keyMemories.linkedObjectOrPlace],
    "小细节还没录进档案。"
  );
  const boundaryText = displayValue(
    profile.boundaries,
    "只在记忆边界里陪你说话，不接乱七八糟的外包任务。"
  );

  const page = document.createElement("main");
  page.className = "console-page";
  page.innerHTML = `
    <section class="console-layout console-layout-axa">
      <section class="chat-stage">
        <div class="stage-backdrop" aria-hidden="true">
          <img src="/design/axa-oracle.webp" alt="" />
        </div>
        <aside class="memory-float-card" data-role="memory-float-card" data-open="true">
          <div class="memory-float-head">
            <div>
              <p class="memory-float-kicker">MEMORY FILE</p>
              <h2>${profile.name}</h2>
            </div>
            <button type="button" class="memory-float-close" data-role="toggle-memory-card">收起</button>
          </div>
          <div class="memory-float-meta">
            <span>${displayValue(profile.relationship, "重要的人")}</span>
            <span>${displayValue(profile.status, "可唤起")}</span>
          </div>
          <div class="memory-float-grid">
            <article>
              <span>称呼</span>
              <p>${displayValue(profile.howUserRefersToThem, personaLabel)}</p>
            </article>
            <article>
              <span>别名</span>
              <p>${(profile.aliases.length > 0 ? profile.aliases : [profile.name]).slice(0, 3).join(" / ")}</p>
            </article>
            <article>
              <span>口头禅</span>
              <p>${catchphrase}</p>
            </article>
            <article>
              <span>关心方式</span>
              <p>${careText}</p>
            </article>
            <article>
              <span>代表场景</span>
              <p>${memoryScene}</p>
            </article>
            <article>
              <span>细节锚点</span>
              <p>${detailAnchor}</p>
            </article>
          </div>
        </aside>
        <button type="button" class="memory-float-reopen" data-role="reopen-memory-card">MEMORY FILE</button>
        <div class="stage-focus">
          <div class="stage-status-card">
            <div class="stage-status-head">
              <span class="stage-status-dot"></span>
              <strong data-role="voice-state">LISTENING...</strong>
            </div>
            <div class="stage-status-line"></div>
            <p data-role="thread-meta">NEURAL_LINK_ESTABLISHED_0.92ms</p>
          </div>
        </div>
        <section class="stage-console">
          <div class="stage-head">
            <div>
              <p class="console-kicker">CHAT LOG</p>
              <h2 data-role="thread-title">正在接入</h2>
            </div>
            <p class="stage-head-copy" data-role="voice-detail">${state.voiceDetail}</p>
          </div>
          <div class="message-feed" data-role="message-feed"></div>
        </section>
        <div class="stage-environment" aria-hidden="true">
          <span>CORE_TEMP: 32°C</span>
          <span>SIGNAL_STRENGTH: 98%</span>
          <span>ENCRYPTION: AES-4096</span>
        </div>
      </section>
    </section>
    <footer class="console-footer">
      <div class="stage-wave">
        <div class="stage-wave-bars" aria-hidden="true">
          ${Array.from({ length: 7 }, (_, index) => `<span style="--bar-delay:${index}; --bar-height:${(index % 5) + 3};"></span>`).join("")}
        </div>
      </div>
      <form class="composer-panel" data-role="composer">
        <label class="ui-hidden">
          <span>message</span>
          <textarea name="message" rows="4" placeholder="说点什么。"></textarea>
        </label>
        <div class="composer-row">
          <div class="composer-actions">
            <button type="button" class="hold-btn hold-btn-hero" data-role="hold-voice">HOLD SPACE TO TALK</button>
            <button type="button" class="ui-hidden" data-role="stop-voice">取消收音</button>
            <button type="submit" class="ui-hidden" data-role="send">发送给本地 Codex</button>
          </div>
        </div>
      </form>
    </footer>
    <section class="console-hidden-mounts ui-hidden">
      <button type="button" data-role="back-home">返回列表</button>
      <button type="button" data-role="new-thread">NEW_SESSION</button>
      <div class="status-chip" data-role="transport-status">连接中</div>
      <div data-role="live-transcript">${state.liveTranscript}</div>
      <button type="button" data-role="use-context">带入输入框</button>
      <div class="thread-list" data-role="thread-list"></div>
      <div class="context-stack" data-role="context-stack"></div>
    </section>
  `;

  renderShell(container, page);

  const threadList = page.querySelector<HTMLElement>("[data-role='thread-list']");
  const messageFeed = page.querySelector<HTMLElement>("[data-role='message-feed']");
  const contextStack = page.querySelector<HTMLElement>("[data-role='context-stack']");
  const memoryFloatCard = page.querySelector<HTMLElement>("[data-role='memory-float-card']");
  const toggleMemoryCardButton = page.querySelector<HTMLButtonElement>("[data-role='toggle-memory-card']");
  const reopenMemoryCardButton = page.querySelector<HTMLButtonElement>("[data-role='reopen-memory-card']");
  const threadTitle = page.querySelector<HTMLElement>("[data-role='thread-title']");
  const threadMeta = page.querySelector<HTMLElement>("[data-role='thread-meta']");
  const transportStatus = page.querySelector<HTMLElement>("[data-role='transport-status']");
  const voiceStateNode = page.querySelector<HTMLElement>("[data-role='voice-state']");
  const voiceDetailNode = page.querySelector<HTMLElement>("[data-role='voice-detail']");
  const liveTranscriptNode = page.querySelector<HTMLElement>("[data-role='live-transcript']");
  const composer = page.querySelector<HTMLFormElement>("[data-role='composer']");
  const textarea = composer?.querySelector<HTMLTextAreaElement>("textarea[name='message']");
  const holdButton = page.querySelector<HTMLButtonElement>("[data-role='hold-voice']");
  const stopVoiceButton = page.querySelector<HTMLButtonElement>("[data-role='stop-voice']");
  const sendButton = page.querySelector<HTMLButtonElement>("[data-role='send']");
  const newThreadButton = page.querySelector<HTMLButtonElement>("[data-role='new-thread']");
  const backButton = page.querySelector<HTMLButtonElement>("[data-role='back-home']");
  const useContextButton = page.querySelector<HTMLButtonElement>("[data-role='use-context']");

  if (
    !threadList ||
    !messageFeed ||
    !contextStack ||
    !memoryFloatCard ||
    !toggleMemoryCardButton ||
    !reopenMemoryCardButton ||
    !threadTitle ||
    !threadMeta ||
    !transportStatus ||
    !voiceStateNode ||
    !voiceDetailNode ||
    !liveTranscriptNode ||
    !composer ||
    !textarea ||
    !holdButton ||
    !stopVoiceButton ||
    !sendButton ||
    !newThreadButton ||
    !backButton ||
    !useContextButton
  ) {
    throw new Error("控制台节点没挂全，像是前端把重要零件落在楼下了。");
  }

  let transportCleanup: (() => void) | null = null;
  let cleanedUp = false;

  const isThreadBusy = () => state.sending || state.currentThread?.status === "running";

  const renderTransportState = () => {
    const label = state.transport === "ws"
      ? "WebSocket 在线"
      : state.transport === "sse"
        ? "SSE 在线"
        : state.transport === "offline"
          ? "桥已离线"
          : "连接中";

    transportStatus.textContent = label;
    transportStatus.dataset.state = state.transport;
  };

  const renderVoiceState = () => {
    const label = voiceLabel(state.voiceState);
    voiceStateNode.textContent = label;
    voiceDetailNode.textContent = state.voiceDetail;
    liveTranscriptNode.textContent = state.liveTranscript;
    page.dataset.voiceState = state.voiceState;

    const speechSupported = speechController.supportsRecognition();
    holdButton.disabled = isThreadBusy() || !speechSupported;
    stopVoiceButton.disabled = !state.captureMode && !speechController.isListening();
    sendButton.disabled = isThreadBusy() || !state.currentThread;
    sendButton.textContent = state.sending ? "发送中..." : "发送给本地 Codex";
  };

  const renderThreadList = () => {
    threadList.innerHTML = "";

    if (!state.workspace || state.workspace.threads.length === 0) {
      const empty = document.createElement("article");
      empty.className = "thread-card thread-card-empty";
      empty.innerHTML = `
        <p>还没有线程。</p>
        <span>先点上面的“新建线程”，别让左侧栏像荒地。</span>
      `;
      threadList.append(empty);
      return;
    }

    state.workspace.threads.forEach((thread) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "thread-card";
      item.dataset.active = String(thread.threadId === state.workspace?.currentThreadId);
      const head = document.createElement("div");
      head.className = "thread-card-head";
      const titleNode = document.createElement("strong");
      titleNode.textContent = thread.title;
      const statusNode = document.createElement("span");
      statusNode.textContent = thread.status === "running" ? "正在回复" : thread.status === "error" ? "有点卡" : "待命";
      head.append(titleNode, statusNode);

      const preview = document.createElement("p");
      preview.textContent = thread.preview || "这条线程还没开口。";

      const foot = document.createElement("div");
      foot.className = "thread-card-foot";
      const timeNode = document.createElement("span");
      timeNode.textContent = formatTime(thread.updatedAt);
      const countNode = document.createElement("span");
      countNode.textContent = `${thread.messageCount} 条消息`;
      foot.append(timeNode, countNode);

      item.append(head, preview, foot);
      item.addEventListener("click", () => {
        void selectThreadById(thread.threadId);
      });
      threadList.append(item);
    });
  };

  const renderMessages = () => {
    messageFeed.innerHTML = "";
    const messages = state.currentThread?.messages ?? [];

    if (messages.length === 0) {
      const empty = document.createElement("article");
      empty.className = "message-placeholder";
      empty.innerHTML = `
        <p>这一条线程还没正式开口。</p>
        <span>说一句话，或者按住空格，让虚拟人和本地 Codex 一起上班。</span>
      `;
      messageFeed.append(empty);
      return;
    }

    messages.forEach((message) => {
      const item = document.createElement("article");
      item.className = `message-bubble message-${message.role}`;
      item.dataset.pending = String(Boolean(message.pending));
      const meta = document.createElement("div");
      meta.className = "message-meta";
      const speaker = document.createElement("span");
      speaker.textContent = message.role === "user" ? "你" : message.role === "assistant" ? personaLabel : "系统";
      const time = document.createElement("strong");
      time.textContent = formatTime(message.createdAt);
      meta.append(speaker, time);

      const text = document.createElement("p");
      text.textContent = message.text || (message.pending ? "..." : "");

      item.append(meta, text);
      messageFeed.append(item);
    });

    messageFeed.scrollTop = messageFeed.scrollHeight;
  };

  const renderContext = () => {
    contextStack.innerHTML = "";
    const entries = state.currentThread?.contextEntries ?? [];

    if (entries.length === 0) {
      const empty = document.createElement("article");
      empty.className = "context-card-item context-card-item-empty";
      empty.textContent = "当前线程还没收到额外上下文。桥倒是醒着，就等你或者宿主再递话。";
      contextStack.append(empty);
      return;
    }

    entries.slice(-5).forEach((entry) => {
      const item = document.createElement("article");
      item.className = "context-card-item";
      const source = document.createElement("span");
      source.textContent = formatContextSource(entry.source);
      const text = document.createElement("p");
      text.textContent = entry.text;
      item.append(source, text);
      contextStack.append(item);
    });
  };

  const renderThreadMeta = () => {
    if (!state.currentThread || !state.workspace) {
      threadTitle.textContent = "正在接入";
      threadMeta.textContent = "NEURAL_LINK_ESTABLISHED_0.92ms";
      return;
    }

    threadTitle.textContent = state.currentThread.title;
    threadMeta.textContent = state.currentThread.status === "running"
      ? "NEURAL_SYNTHESIS_ACTIVE"
      : "NEURAL_LINK_ESTABLISHED_0.92ms";
  };

  const renderMemoryCard = () => {
    memoryFloatCard.dataset.open = String(state.memoryPanelOpen);
    reopenMemoryCardButton.hidden = state.memoryPanelOpen;
    toggleMemoryCardButton.textContent = state.memoryPanelOpen ? "收起" : "展开";
  };

  const renderAll = () => {
    renderTransportState();
    renderVoiceState();
    renderThreadList();
    renderMessages();
    renderContext();
    renderThreadMeta();
    renderMemoryCard();
  };

  const speechController = new SpeechController({
    onTranscript: (text) => {
      textarea.value = text;
      state.liveTranscript = text || "正在收音，想到哪儿说到哪儿。";
      renderVoiceState();
    },
    onStateChange: (nextState, detail) => {
      state.voiceState = nextState;
      state.voiceDetail = detail ?? "机器人状态正常。";

      if (nextState === "listening") {
        state.liveTranscript = "继续说，松开之后这句话会直接送去本地 Codex。";
      }

      if (nextState === "unsupported") {
        state.captureMode = null;
        state.liveTranscript = "当前浏览器不支持语音识别，今天就别逼它装神通了，直接打字吧。";
      }

      renderVoiceState();
    },
    onCaptureComplete: (text) => {
      void sendMessage(text);
    }
  });

  const updateWorkspace = (workspace: WorkspaceRecord) => {
    state.workspace = {
      ...workspace,
      threads: [...workspace.threads].sort((left, right) => right.updatedAt - left.updatedAt)
    };
    updateUrlState(state.profile.name, workspace.sessionId, workspace.currentThreadId, state.serverUrl);
  };

  const updateCurrentThread = (thread: ThreadRecord) => {
    state.currentThread = {
      ...thread,
      messages: [...thread.messages].sort((left, right) => left.createdAt - right.createdAt),
      contextEntries: [...thread.contextEntries].sort((left, right) => left.timestamp - right.timestamp)
    };

    if (state.workspace) {
      state.workspace = {
        ...state.workspace,
        currentThreadId: thread.threadId,
        threads: upsertThreadSummary(state.workspace.threads, {
          threadId: thread.threadId,
          title: thread.title,
          preview: thread.preview,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          status: thread.status,
          lastError: thread.lastError,
          messageCount: thread.messageCount,
          contextCount: thread.contextCount
        })
      };
      updateUrlState(state.profile.name, state.workspace.sessionId, thread.threadId, state.serverUrl);
    }
  };

  const applySelectionPayload = (payload: { workspace: WorkspaceRecord; thread: ThreadRecord }) => {
    updateWorkspace(payload.workspace);
    updateCurrentThread(payload.thread);
    renderAll();
  };

  const selectThreadById = async (threadId: string) => {
    if (!state.workspace) {
      return;
    }

    const payload = await rpcCall<{ workspace: WorkspaceRecord; thread: ThreadRecord }>(
      state.serverUrl,
      "thread/select",
      {
        sessionId: state.workspace.sessionId,
        threadId
      }
    );
    applySelectionPayload(payload);
  };

  const createThreadAction = async () => {
    if (!state.workspace) {
      return;
    }

    const payload = await rpcCall<{ workspace: WorkspaceRecord; thread: ThreadRecord }>(
      state.serverUrl,
      "thread/create",
      {
        sessionId: state.workspace.sessionId,
        personId: state.profile.name
      }
    );
    applySelectionPayload(payload);
  };

  const sendMessage = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || !state.workspace || !state.currentThread || isThreadBusy()) {
      if (trimmed && state.currentThread?.status === "running") {
        state.voiceState = "error";
        state.voiceDetail = "上一句还没说完，先别让本地 Codex 一心二用。";
        renderVoiceState();
      }
      return;
    }

    state.sending = true;
    state.voiceState = "processing";
    state.voiceDetail = "消息已经发出，本地 Codex 正在翻这个人的设定。";
    state.liveTranscript = trimmed;
    renderVoiceState();

    try {
      const payload = await rpcCall<{ workspace: WorkspaceRecord; thread: ThreadRecord }>(
        state.serverUrl,
        "turn/send",
        {
          sessionId: state.workspace.sessionId,
          threadId: state.currentThread.threadId,
          text: trimmed
        }
      );

      textarea.value = "";
      applySelectionPayload(payload);
    } catch (error) {
      state.voiceState = "error";
      state.voiceDetail = error instanceof Error ? error.message : "消息发送失败。";
      state.liveTranscript = trimmed;
    } finally {
      state.sending = false;
      renderVoiceState();
    }
  };

  const pushSharedContext = async (entries: SharedContextEntry[], replace = false) => {
    if (!state.workspace || !state.currentThread || entries.length === 0) {
      return;
    }

    const payload = await rpcCall<{ workspace: WorkspaceRecord; thread: ThreadRecord }>(
      state.serverUrl,
      "context/push",
      {
        sessionId: state.workspace.sessionId,
        threadId: state.currentThread.threadId,
        entries,
        replace,
        source: "browser-host"
      }
    );
    applySelectionPayload(payload);
  };

  const toggleMemoryCard = (next?: boolean) => {
    state.memoryPanelOpen = next ?? !state.memoryPanelOpen;
    renderMemoryCard();
  };

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    transportCleanup?.();
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("keyup", handleKeyUp);
  };

  const beginVoiceCapture = (mode: "keyboard" | "pointer") => {
    if (!speechController.supportsRecognition() || isThreadBusy() || state.captureMode || speechController.isListening()) {
      if (state.currentThread?.status === "running") {
        state.voiceState = "error";
        state.voiceDetail = "机器人上一句还没讲完，先别继续塞话。";
        renderVoiceState();
      }
      return;
    }

    state.captureMode = mode;
    textarea.value = "";
    state.liveTranscript = mode === "keyboard"
      ? "空格键收音中，继续说，松开就会发给本地 Codex。"
      : "按钮收音中，继续说，松开就会发给本地 Codex。";
    renderVoiceState();
    void startVoiceSession(speechController);
  };

  const cancelVoiceCapture = () => {
    state.captureMode = null;
    state.voiceState = "idle";
    state.voiceDetail = "收音已取消，机器人把耳朵先收起来了。";
    state.liveTranscript = "这次没发出去。再按一次空格，或者直接打字。";
    renderVoiceState();

    if (speechController.isListening()) {
      stopVoiceSession(speechController);
    }
  };

  const handleNotification = (event: NotificationEvent) => {
    if (event.type === "transport.ready") {
      const transport = event.payload?.transport;
      if (transport === "ws" || transport === "sse") {
        state.transport = transport;
        renderTransportState();
      }
      if (event.payload?.workspace && typeof event.payload.workspace === "object") {
        updateWorkspace(event.payload.workspace as WorkspaceRecord);
        renderThreadList();
      }
      return;
    }

    if (event.payload?.workspace && typeof event.payload.workspace === "object") {
      updateWorkspace(event.payload.workspace as WorkspaceRecord);
    }

    if (event.type === "thread.created" || event.type === "thread.updated") {
      const nextThread = event.payload?.thread as ThreadSummary | undefined;
      if (nextThread && state.workspace) {
        state.workspace = {
          ...state.workspace,
          threads: upsertThreadSummary(state.workspace.threads, nextThread)
        };
      }
      renderThreadList();
      renderThreadMeta();
      return;
    }

    if (event.type === "thread.selected" && state.workspace) {
      state.workspace = {
        ...state.workspace,
        currentThreadId: event.threadId ?? state.workspace.currentThreadId
      };
      renderThreadList();
      renderThreadMeta();
      return;
    }

    if (!state.currentThread || event.threadId !== state.currentThread.threadId) {
      renderThreadList();
      return;
    }

    if (event.type === "thread.message.appended") {
      const message = event.payload?.message as ThreadMessage | undefined;
      if (message) {
        state.currentThread = {
          ...state.currentThread,
          messages: upsertThreadMessage(state.currentThread.messages, message),
          updatedAt: Date.now(),
          messageCount: Math.max(state.currentThread.messages.length + 1, state.currentThread.messageCount),
          preview: message.text || state.currentThread.preview
        };
        renderMessages();
      }
      return;
    }

    if (event.type === "thread.message.delta") {
      const messageId = String(event.payload?.messageId ?? "");
      const text = String(event.payload?.text ?? "");
      state.currentThread = {
        ...state.currentThread,
        messages: state.currentThread.messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                text,
                pending: true
              }
            : message
        ),
        preview: text || state.currentThread.preview,
        updatedAt: Date.now()
      };
      renderMessages();
      return;
    }

    if (event.type === "thread.message.completed") {
      const message = event.payload?.message as ThreadMessage | undefined;
      if (message) {
        state.currentThread = {
          ...state.currentThread,
          messages: upsertThreadMessage(state.currentThread.messages, {
            ...message,
            pending: false
          }),
          preview: message.text || state.currentThread.preview,
          status: "idle",
          updatedAt: Date.now()
        };
        state.voiceState = "idle";
        state.voiceDetail = "本地 Codex 已经说完这句。";
        renderMessages();
        renderVoiceState();
        void speechController.speak(message.text, profile.name);
      }
      return;
    }

    if (event.type === "thread.state.changed") {
      const nextState = String(event.payload?.state ?? "idle");
      const detail = typeof event.payload?.detail === "string" ? event.payload.detail : "";
      state.currentThread = {
        ...state.currentThread,
        status: nextState,
        lastError: detail || null,
        updatedAt: Date.now()
      };
      if (nextState === "running") {
        state.voiceState = "processing";
      } else if (nextState === "error") {
        state.voiceState = "error";
      } else if (state.voiceState === "processing") {
        state.voiceState = "idle";
      }
      state.voiceDetail = detail || state.voiceDetail;
      renderThreadMeta();
      renderVoiceState();
      renderThreadList();
      return;
    }

    if (event.type === "context.updated") {
      const entries = Array.isArray(event.payload?.entries)
        ? event.payload.entries as SharedContextEntry[]
        : [];
      const replace = Boolean(event.payload?.replace);
      state.currentThread = {
        ...state.currentThread,
        contextEntries: replace ? entries : [...state.currentThread.contextEntries, ...entries]
      };
      renderContext();
    }
  };

  const initial = await rpcCall<{ workspace: WorkspaceRecord; thread: ThreadRecord; avatarUrl: string }>(
    state.serverUrl,
    "persona/select",
    {
      personId: profile.name,
      sessionId: getQuerySessionId(),
      threadId: getQueryThreadId()
    }
  );

  applySelectionPayload({
    workspace: initial.workspace,
    thread: initial.thread
  });

  transportCleanup = createRealtimeTransport(
    state.serverUrl,
    initial.workspace.sessionId,
    handleNotification,
    (transport) => {
      state.transport = transport;
      renderTransportState();
    }
  );

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage(textarea.value);
  });

  newThreadButton.addEventListener("click", () => {
    void createThreadAction();
  });

  toggleMemoryCardButton.addEventListener("click", () => {
    toggleMemoryCard(false);
  });

  reopenMemoryCardButton.addEventListener("click", () => {
    toggleMemoryCard(true);
  });

  backButton.addEventListener("click", () => {
    cleanup();
    window.location.href = `${window.location.origin}${window.location.pathname}`;
  });

  holdButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    holdButton.setPointerCapture(event.pointerId);
    beginVoiceCapture("pointer");
  });

  const releasePointerCapture = (event: PointerEvent) => {
    if (holdButton.hasPointerCapture(event.pointerId)) {
      holdButton.releasePointerCapture(event.pointerId);
    }

    if (state.captureMode !== "pointer") {
      return;
    }

    state.captureMode = null;
    if (speechController.isListening()) {
      stopVoiceSession(speechController, { submit: true });
    }
  };

  holdButton.addEventListener("pointerup", releasePointerCapture);
  holdButton.addEventListener("pointercancel", releasePointerCapture);

  stopVoiceButton.addEventListener("click", () => {
    cancelVoiceCapture();
  });

  useContextButton.addEventListener("click", () => {
    const entries = state.currentThread?.contextEntries ?? [];
    if (entries.length === 0) {
      textarea.focus();
      return;
    }

    const merged = entries.slice(-3).map((entry) => entry.text).join("\n");
    textarea.value = textarea.value.trim()
      ? `${textarea.value.trim()}\n\n补充上下文：\n${merged}`
      : `结合这些上下文继续聊：\n${merged}`;
    state.liveTranscript = textarea.value;
    renderVoiceState();
    textarea.focus();
  });

  const handleKeyDown = (event: KeyboardEvent) => {
    if (
      event.code !== "Space" ||
      event.repeat ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isEditableTarget(event.target) ||
      isEditableTarget(document.activeElement)
    ) {
      return;
    }

    event.preventDefault();
    beginVoiceCapture("keyboard");
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    if (
      event.code !== "Space" ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isEditableTarget(event.target) ||
      isEditableTarget(document.activeElement)
    ) {
      return;
    }

    if (state.captureMode !== "keyboard") {
      return;
    }

    event.preventDefault();
    state.captureMode = null;
    if (speechController.isListening()) {
      stopVoiceSession(speechController, { submit: true });
    }
  };

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);
  window.addEventListener(
    "beforeunload",
    () => {
      cleanup();
    },
    { once: true }
  );

  window.launchMemoryUser = launchMemoryUser;
  window.launchMemoryAvatar = launchMemoryUser;
  window.mossCodexUI = {
    open: launchMemoryUser
  };
  window.mossMemoryBridge = {
    launchUser: launchMemoryUser,
    launchAvatar: launchMemoryUser,
    pushContext: (entries, replace = false) => {
      void pushSharedContext(normalizeContextEntries(entries), replace);
    },
    sendEnvelope: (data) => {
      if (!state.workspace || !state.currentThread) {
        return;
      }

      void postJson(`${state.serverUrl}/api/memory/event`, {
        ...(typeof data === "object" && data ? data : {}),
        sessionId: state.workspace.sessionId,
        threadId: state.currentThread.threadId
      }).catch(() => {
        // 宿主发封信失败时，页面别跟着一起演掉线惊魂。
      });
    }
  };

  renderAll();
}

function renderError(container: HTMLElement, message: string): void {
  const page = document.createElement("main");
  page.className = "error-page";
  page.innerHTML = `
    <section class="error-panel">
      <p class="console-kicker">AXA // System Fault</p>
      <h1>控制台接线失败。</h1>
      <p>${message}</p>
      <button type="button" class="primary-btn" data-role="back-home">返回人物列表</button>
    </section>
  `;

  renderShell(container, page);
  page.querySelector<HTMLButtonElement>("[data-role='back-home']")?.addEventListener("click", () => {
    window.location.href = `${window.location.origin}${window.location.pathname}`;
  });
}

export async function bootstrapApp(container: HTMLElement | null): Promise<void> {
  if (!container) {
    throw new Error("找不到应用挂载点。");
  }

  window.launchMemoryUser = launchMemoryUser;
  window.launchMemoryAvatar = launchMemoryUser;
  window.mossCodexUI = {
    open: launchMemoryUser
  };
  window.mossMemoryBridge = {
    launchUser: launchMemoryUser,
    launchAvatar: launchMemoryUser,
    pushContext: () => {},
    sendEnvelope: () => {}
  };

  try {
    const people = await loadMemoryIndex();
    const personId = getQueryPerson();

    if (!personId) {
      renderHome(container, people);
      return;
    }

    if (people.length === 0) {
      throw new Error("记忆库里还没有人物档案，首页我已经裁了，现在连门牌都没得挂。");
    }

    const profile = await loadPersonProfile(personId);
    await renderConsole(container, profile);
  } catch (error) {
    renderError(container, error instanceof Error ? error.message : "未知错误");
  }
}
