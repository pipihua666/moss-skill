import { loadMemoryIndex, loadPersonProfile } from "../data/memoryLoader";
import { MemoryBridge } from "../bridge/channel";
import { generatePersonaReply } from "../persona/reply";
import type {
  BridgeEnvelope,
  ConversationTurn,
  MemoryIndex,
  PersonProfile,
  SharedContextEntry,
  VoiceSessionState
} from "../types";
import { RobotScene } from "../avatar/robotScene";
import { SpeechController, startVoiceSession, stopVoiceSession } from "../voice/speech";

function createTurn(
  speaker: ConversationTurn["speaker"],
  text: string
): ConversationTurn {
  return {
    id: `${speaker}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    speaker,
    text,
    timestamp: Date.now()
  };
}

function getQueryPerson(): string | null {
  return new URLSearchParams(window.location.search).get("person");
}

function getQueryBridgeId(): string | null {
  return new URLSearchParams(window.location.search).get("bridge");
}

function createSharedContextEntry(text: string, source = "agent"): SharedContextEntry {
  return {
    id: `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source,
    text,
    timestamp: Date.now()
  };
}

export function launchMemoryAvatar(
  personId: string,
  options?: {
    bridgeId?: string;
    context?: string | string[];
  }
): void {
  const url = new URL(window.location.href);
  url.searchParams.set("person", personId);
  const bridgeId = options?.bridgeId ?? crypto.randomUUID();
  url.searchParams.set("bridge", bridgeId);
  const popup = window.open(url.toString(), "_blank", "noopener,noreferrer");

  if (!popup) {
    window.location.href = url.toString();
    return;
  }

  if (options?.context) {
    const texts = Array.isArray(options.context) ? options.context : [options.context];
    const entries = texts.filter(Boolean).map((text) => createSharedContextEntry(text, "agent"));
    const sendInitialContext = () => {
      const envelope: BridgeEnvelope<"bridge:context-update"> = {
        type: "bridge:context-update",
        bridgeId,
        payload: {
          entries,
          replace: true
        }
      };
      popup.postMessage(envelope, "*");
    };

    setTimeout(sendInitialContext, 300);
  }
}

function renderShell(container: HTMLElement, content: HTMLElement): void {
  container.innerHTML = "";
  const shell = document.createElement("div");
  shell.className = "app-shell";
  shell.append(content);
  container.append(shell);
}

function renderHome(container: HTMLElement, people: MemoryIndex[]): void {
  const home = document.createElement("main");
  home.className = "home-page";

  const hero = document.createElement("section");
  hero.className = "hero-panel";
  hero.innerHTML = `
    <div class="hero-grid">
      <div class="hero-copy-block">
        <p class="eyebrow">MOSS 思念陪伴</p>
        <h1>把回忆请进一个会眨眼、会说话的机器人里。</h1>
        <p class="hero-copy">点开某个人，系统会自动唤起独立虚拟人页。它会按档案里的说话方式和你聊，但不会自作主张替人加戏，毕竟回忆最怕擅自编剧。</p>
        <div class="hero-actions">
          <span class="hero-pill">3D Avatar</span>
          <span class="hero-pill">浏览器语音</span>
          <span class="hero-pill">记忆人格约束</span>
        </div>
        <div class="hero-ledger" aria-label="能力概览">
          <article>
            <span>01</span>
            <strong>保留语气</strong>
            <p>人物说话方式从档案里长出来，不从空气里瞎长。</p>
          </article>
          <article>
            <span>02</span>
            <strong>同步上下文</strong>
            <p>主会话和虚拟人页互相递话，不让陪伴体验各聊各的。</p>
          </article>
        </div>
      </div>
      <div class="hero-aside">
        <div class="hero-reactor" aria-hidden="true">
          <div class="reactor-ring reactor-ring-a"></div>
          <div class="reactor-ring reactor-ring-b"></div>
          <div class="reactor-core"></div>
        </div>
        <div class="hero-metrics">
          <p class="hero-aside-label">当前记忆库</p>
          <strong>${people.length}</strong>
          <span>位可唤起人物</span>
        </div>
        <p>人物风格来自 <code>references/</code> 档案，虚拟人只会在记忆边界内说话，不会突然兼职企业客服。</p>
        <div class="hero-signal">
          <span>voice relay</span>
          <span>context bridge</span>
          <span>persona guardrail</span>
        </div>
      </div>
    </div>
  `;

  const list = document.createElement("section");
  list.className = "memory-list";
  list.innerHTML = `
    <div class="section-head">
      <div>
        <p class="section-kicker">Memory Ledger</p>
        <h2>已记录的人物</h2>
      </div>
      <p>目前从 references 档案中读取。每张卡片都像一封被折好的旧信，点开才开始说话。</p>
    </div>
  `;

  const grid = document.createElement("div");
  grid.className = "memory-grid";

  people.forEach((person) => {
    const card = document.createElement("article");
    card.className = "memory-card";
    card.innerHTML = `
      <div class="memory-card-topline">
        <p class="memory-role">${person.relationship}</p>
        <span class="memory-index">#${String(grid.children.length + 1).padStart(2, "0")}</span>
      </div>
      <div class="memory-card-head">
        <h3>${person.name}</h3>
        <p>${person.status}</p>
      </div>
      <div class="memory-divider" aria-hidden="true"></div>
      <div class="memory-tags">
        ${(person.aliases.length > 0 ? person.aliases : [person.name])
          .slice(0, 3)
          .map((alias) => `<span>${alias}</span>`)
          .join("")}
      </div>
      <p class="memory-meta">最近更新：${person.lastUpdated}</p>
    `;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-btn";
    button.textContent = "唤起虚拟人";
    button.addEventListener("click", () => launchMemoryAvatar(person.name));
    card.append(button);
    grid.append(card);
  });

  list.append(grid);
  home.append(hero, list);
  renderShell(container, home);
}

function renderMessage(turn: ConversationTurn): HTMLElement {
  const item = document.createElement("article");
  item.className = `message message-${turn.speaker}`;
  item.innerHTML = `
    <span class="message-speaker">${turn.speaker === "user" ? "你" : turn.speaker === "persona" ? "TA" : "系统"}</span>
    <p>${turn.text}</p>
  `;
  return item;
}

function updateMessages(container: HTMLElement, turns: ConversationTurn[]): void {
  container.innerHTML = "";
  turns.forEach((turn) => container.append(renderMessage(turn)));
  container.scrollTop = container.scrollHeight;
}

function voiceLabel(state: VoiceSessionState): string {
  switch (state) {
    case "idle":
      return "待机";
    case "requesting-permission":
      return "申请麦克风";
    case "listening":
      return "正在听";
    case "processing":
      return "正在想";
    case "speaking":
      return "正在说";
    case "unsupported":
      return "浏览器不支持";
    case "error":
      return "出错了";
    default:
      return "待机";
  }
}

function renderContextChips(container: HTMLElement, entries: SharedContextEntry[]): void {
  container.innerHTML = "";

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "context-empty";
    empty.textContent = "还没收到宿主应用上下文，桥已经搭好，就等那头递话。";
    container.append(empty);
    return;
  }

  entries.slice(-6).forEach((entry) => {
    const item = document.createElement("article");
    item.className = "context-item";
    item.innerHTML = `
      <span>${entry.source}</span>
      <p>${entry.text}</p>
    `;
    container.append(item);
  });
}

function renderAvatarPage(container: HTMLElement, profile: PersonProfile): void {
  const bridgeId = getQueryBridgeId() ?? crypto.randomUUID();
  const page = document.createElement("main");
  page.className = "avatar-page";
  page.innerHTML = `
    <section class="persona-banner">
      <div>
        <p class="eyebrow">Memory Avatar</p>
        <h1>${profile.name}</h1>
        <p class="persona-copy">关系：${profile.relationship}。说话风格：${profile.speakingStyle.tone}。边界：${profile.boundaries}。</p>
        <div class="persona-tags">
          <span>${profile.relationship}</span>
          <span>${profile.speakingStyle.tone}</span>
          <span>${profile.status}</span>
        </div>
        <div class="persona-facts">
          <article>
            <span>安慰方式</span>
            <strong>${profile.behaviorStyle.showCare}</strong>
          </article>
          <article>
            <span>代表记忆</span>
            <strong>${profile.keyMemories.memorableScene}</strong>
          </article>
        </div>
      </div>
      <button type="button" class="ghost-btn" data-role="back-home">返回人物列表</button>
    </section>
    <section class="avatar-layout">
      <div class="avatar-stage">
        <div class="stage-head">
          <div>
            <p class="stage-kicker">Synthetic Presence</p>
            <h2>语音虚拟人舞台</h2>
          </div>
          <p>麦克风输入、系统语音播报、人物口吻约束同时在线。</p>
        </div>
        <div class="robot-stage" data-role="robot-stage"></div>
        <div class="status-strip">
          <div class="status-main">
            <span class="status-badge" data-role="voice-state">待机</span>
            <p data-role="voice-detail">准备就绪，机器人在屏息凝神。</p>
          </div>
          <div class="stage-orbit">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      </div>
      <div class="conversation-panel">
        <div class="conversation-topline">
          <p>Conversation Console</p>
          <span>与宿主会话保持同频</span>
        </div>
        <div class="shared-context-panel">
          <div class="panel-head">
            <h2>当前 Agent 上下文</h2>
            <span>双向同步</span>
          </div>
          <div class="context-list" data-role="context-list"></div>
          <div class="context-actions">
            <button type="button" class="ghost-btn" data-role="request-context">请求最新上下文</button>
            <button type="button" class="ghost-btn" data-role="use-context">把上下文带进输入框</button>
          </div>
        </div>
        <div class="profile-notes">
          <div class="panel-head">
            <h2>人物提示</h2>
            <span>只读档案</span>
          </div>
          <p>${profile.behaviorStyle.showCare}</p>
          <p>${profile.keyMemories.smallDetails}</p>
        </div>
        <div class="messages" data-role="messages"></div>
        <form class="composer" data-role="composer">
          <label class="composer-field">
            <span>你想说什么</span>
            <textarea name="message" rows="4" placeholder="可以直接打字，也可以点下面的收音按钮。"></textarea>
          </label>
          <div class="composer-actions">
            <button type="button" class="ghost-btn" data-role="listen">开始收音</button>
            <button type="button" class="ghost-btn" data-role="stop-listen">停止收音</button>
            <button type="submit" class="primary-btn">发送给虚拟人</button>
          </div>
        </form>
      </div>
    </section>
  `;

  renderShell(container, page);

  const robotMount = page.querySelector<HTMLElement>("[data-role='robot-stage']");
  const messagesNode = page.querySelector<HTMLElement>("[data-role='messages']");
  const voiceStateNode = page.querySelector<HTMLElement>("[data-role='voice-state']");
  const voiceDetailNode = page.querySelector<HTMLElement>("[data-role='voice-detail']");
  const form = page.querySelector<HTMLFormElement>("[data-role='composer']");
  const textarea = form?.querySelector<HTMLTextAreaElement>("textarea[name='message']");
  const listenButton = page.querySelector<HTMLButtonElement>("[data-role='listen']");
  const stopButton = page.querySelector<HTMLButtonElement>("[data-role='stop-listen']");
  const backButton = page.querySelector<HTMLButtonElement>("[data-role='back-home']");
  const contextList = page.querySelector<HTMLElement>("[data-role='context-list']");
  const requestContextButton = page.querySelector<HTMLButtonElement>("[data-role='request-context']");
  const useContextButton = page.querySelector<HTMLButtonElement>("[data-role='use-context']");

  if (!robotMount || !messagesNode || !voiceStateNode || !voiceDetailNode || !form || !textarea || !listenButton || !stopButton || !backButton || !contextList || !requestContextButton || !useContextButton) {
    throw new Error("页面初始化失败，机器人还没组装好。");
  }

  const robotScene = new RobotScene(robotMount);
  const sharedContext: SharedContextEntry[] = [];
  const turns: ConversationTurn[] = [
    createTurn("system", `${profile.name} 的虚拟人已经上线，麦克风和扬声器准备接客。`),
    createTurn("persona", `${profile.speakingStyle.catchphrases[0] ? `${profile.speakingStyle.catchphrases[0]}，` : ""}我在这儿。你慢慢说，我听着。`)
  ];

  updateMessages(messagesNode, turns);
  renderContextChips(contextList, sharedContext);

  const bridge = new MemoryBridge({
    bridgeId,
    personId: profile.name,
    onContextUpdate: (entries, replace) => {
      if (replace) {
        sharedContext.length = 0;
      }

      entries.forEach((entry) => {
        if (!sharedContext.some((item) => item.id === entry.id)) {
          sharedContext.push(entry);
        }
      });

      renderContextChips(contextList, sharedContext);
    }
  });

  const setVoiceState = (state: VoiceSessionState, detail?: string) => {
    voiceStateNode.textContent = voiceLabel(state);
    voiceDetailNode.textContent = detail ?? "机器人状态正常。";
    robotScene.setMood(state);
    bridge.syncStatus(state, detail);
  };

  const speechController = new SpeechController({
    onTranscript: (text) => {
      textarea.value = text;
    },
    onStateChange: (state, detail) => {
      setVoiceState(state, detail);
    }
  });

  const submitMessage = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }

    turns.push(createTurn("user", trimmed));
    updateMessages(messagesNode, turns);
    textarea.value = "";
    setVoiceState("processing", "虚拟人正在翻人物档案，没在偷懒。");
    bridge.syncUserMessage(trimmed);

    const reply = await generatePersonaReply({
      profile,
      turns: [
        ...turns,
        ...sharedContext.map((entry) =>
          createTurn("system", `[上下文/${entry.source}] ${entry.text}`)
        )
      ],
      input: sharedContext.length > 0
        ? `${trimmed}\n\n当前外部上下文：\n${sharedContext.map((entry) => `- ${entry.text}`).join("\n")}`
        : trimmed
    });

    turns.push(createTurn("persona", reply.text));
    if (reply.suggestedFollowUp && !reply.boundaryTriggered) {
      turns.push(createTurn("system", `建议继续聊：${reply.suggestedFollowUp}`));
    }

    updateMessages(messagesNode, turns);
    bridge.syncPersonaMessage(reply.text);
    await speechController.speak(reply.text, profile.name);
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitMessage(textarea.value);
  });

  listenButton.addEventListener("click", () => {
    void startVoiceSession(speechController);
  });

  stopButton.addEventListener("click", () => {
    stopVoiceSession(speechController);
  });

  requestContextButton.addEventListener("click", () => {
    bridge.requestContext("manual-refresh");
  });

  useContextButton.addEventListener("click", () => {
    if (sharedContext.length === 0) {
      textarea.value = textarea.value.trim();
      return;
    }

    const merged = sharedContext
      .slice(-3)
      .map((entry) => entry.text)
      .join("\n");

    textarea.value = textarea.value.trim()
      ? `${textarea.value.trim()}\n\n补充上下文：\n${merged}`
      : `结合这些上下文继续聊：\n${merged}`;
    textarea.focus();
  });

  backButton.addEventListener("click", () => {
    bridge.destroy();
    robotScene.dispose();
    window.location.href = `${window.location.origin}${window.location.pathname}`;
  });

  bridge.announceReady();

  window.addEventListener(
    "beforeunload",
    () => {
      bridge.destroy();
      robotScene.dispose();
    },
    { once: true }
  );
}

function renderError(container: HTMLElement, message: string): void {
  const page = document.createElement("main");
  page.className = "error-page";
  page.innerHTML = `
    <section class="hero-panel">
      <p class="eyebrow">Memory Avatar</p>
      <h1>虚拟人没能顺利起床。</h1>
      <p class="hero-copy">${message}</p>
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

  window.launchMemoryAvatar = launchMemoryAvatar;
  window.mossMemoryBridge = {
    launchAvatar: launchMemoryAvatar,
    pushContext: (entries, replace = false) => {
      const bridgeId = getQueryBridgeId();
      if (!bridgeId) {
        return;
      }

      const payloadEntries = (Array.isArray(entries) ? entries : [entries])
        .filter(Boolean)
        .map((text) => createSharedContextEntry(text, "agent"));

      window.postMessage(
        {
          type: "bridge:context-update",
          bridgeId,
          payload: {
            entries: payloadEntries,
            replace
          }
        } satisfies BridgeEnvelope<"bridge:context-update">,
        "*"
      );
    },
    sendEnvelope: (data) => {
      window.postMessage(data, "*");
    }
  };

  try {
    const people = await loadMemoryIndex();
    const personId = getQueryPerson();

    if (personId) {
      const profile = await loadPersonProfile(personId);
      renderAvatarPage(container, profile);
      return;
    }

    renderHome(container, people);
  } catch (error) {
    renderError(container, error instanceof Error ? error.message : "未知错误");
  }
}
