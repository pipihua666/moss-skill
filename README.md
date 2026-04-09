<h1 align="center"><u>MOSS Skill</u></h1>

## 介绍

我是 `MOSS Skill`。

我的名字借自《流浪地球》里的 MOSS，但我不负责拯救地球，我主要负责另一件更私人的事：把想念留住。

如果你突然想起奶奶、妈妈、老师、朋友，或者某个已经很久没人再提起的名字，我会尽量根据你留下来的记忆，把这份想念接住，而不是敷衍你一句“请节哀顺变”。那种回答太省事了，我不走这种偷懒路线。

## 宗旨

我的宗旨只有四个字：思念永生。

我不想把“想念一个人”做成一次性情绪消费。我更想做的，是帮你把一个人的说话方式、习惯、脾气、关心人的方式，一点点存下来。这样下次你再来找我时，不是面对一个空白的模型，而是面对一份更接近“他真的来过”的记忆。

## 怎么使用我

你可以把我理解成一个会陪你回忆某个人、也会尽量用那个人语气和你说话的技能。

你直接告诉我“我想谁了”就行。

- 如果我已经有这个人的记忆档案，我会根据档案里的内容，用对方的第一人称口吻和你交流
- 如果我还没有这个人的记忆，我会先问你几句，把这个人补充清楚，再继续聊
- 如果档案里的信息还不够，我会少说一点，克制一点，不乱编，不硬演
- 一旦我切到这个人的口吻，我就只陪你交流和回忆，不帮你做事，不代写内容，不列计划，也不处理任务

适合我的打开方式，大概像这样：

- “我想外婆了”
- “你用我妈妈平时安慰我的语气，跟我说几句话”
- “我想补一下爷爷的记忆”

不太适合我的打开方式，大概像这样：

- “你现在扮成我爷爷，顺便帮我写个工作总结”
- “你用我朋友的语气，帮我列个旅游计划”

前一种我会接得很认真，后一种我会婉拒。毕竟我是来陪你想人的，不是来把思念外包成代办清单的。

## 使用方式

### Claude Code

如果你想在 Claude Code 里用我，可以把我挂到技能目录：

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)" ~/.claude/skills/moss-skill
```

重启或重新进入 `claude` 后，它就能按描述发现我。

### Codex

如果你在 Codex 里用我，可以放在仓库内：

```bash
mkdir -p .agents/skills
ln -s "$(pwd)" .agents/skills/moss-skill
```

也可以放到用户目录：

```bash
mkdir -p ~/.agents/skills
ln -s "$(pwd)" ~/.agents/skills/moss-skill
```

Codex 支持自动触发，也支持你直接点名：

```text
$moss-skill 我想外婆了
```

### Gemini CLI

Gemini CLI 没沿用这套技能目录约定，稳一点的做法，是把我挂进项目的 `GEMINI.md` 上下文里：

```bash
cat > GEMINI.md <<'EOF'
# Project memory

@./SKILL.md
@./references/MEMORY.md
@./references/PERSON_TEMPLATE.md
EOF
```

启动 `gemini` 后刷新上下文：

```text
/memory refresh
```

## 记忆库说明

如果你不知道怎么写，也可以先参考仓库里的模板：

- `references/PERSON_TEMPLATE.md`

我建议每个人至少记下这些内容：

- 姓名和别名
- 和你的关系
- 标志性的说话方式或口头禅
- 做事风格、习惯动作、表达关心的方式
- 一个最有代表性的回忆场景
- 明确不能瞎补的边界

如果这个人还不存在，我会先问你几句，把最关键的记忆补上，再创建对应的回忆。

## 示例

```text
$moss-skill 我想<某个人>了
```

```text
$moss-skill 帮我补一下<某个人>的记忆档案
```

```text
$moss-skill 用<某个人>平时安慰我的语气，跟我说几句话
```

```text
$moss-skill <称呼>你还好吗
```

## 虚拟人网页

仓库现在额外带了一个前端 demo：当你切到某个人物时，可以唤起独立的 3D 虚拟人页面。

- 3D 形象用 `three.js` 渲染统一机器人，不做真人高仿，主打一个“有陪伴感，少点恐怖谷”
- 页面会读取 `references/` 里的记忆档案，按人物现有说话方式生成回复
- 支持浏览器麦克风收音和系统 TTS 外放
- 如果浏览器不支持语音识别，可以退回文本输入，不至于整页像断电的路由器

### 启动方式

先安装依赖：

```bash
npm install
```

启动开发环境：

```bash
npm run dev
```

打开首页后，可以从人物列表里点击“唤起虚拟人”；也可以直接访问带人物参数的地址，例如：

```text
http://localhost:5173/?person=奶奶
```

如果你想让技能在“切换到某个回忆人物”时自动把页面拉起来，可以直接用仓库内置脚本：

```bash
npm run avatar:launch -- "奶奶"
```

这个命令会做四件事：

- 检查 `http://127.0.0.1:4173/` 是否已经有本项目的虚拟人服务
- 没有的话自动在后台启动 `npm run dev:avatar`
- 等待服务就绪
- 自动打开对应人物页面，例如 `http://127.0.0.1:4173/?person=奶奶`

这样以后技能切到人物时，就不是“纯口头到场”，而是连浏览器里的机器人都一起上班。

如果当前运行环境是受限沙箱，拦了“本地端口监听”或“打开浏览器”这两步，脚本会自动降级为：

- 明确提示是环境权限问题，不把锅甩给项目代码
- 尽量给出可访问的本地 URL
- 技能继续按人物口吻对话，不把拉页失败当成整段流程报废

如果你想从别的上下文里直接拉起页面，前端还暴露了一个全局方法：

```js
window.launchMemoryAvatar("奶奶");
```

### 和宿主 Agent 双向通信

虚拟人页现在支持和当前 Agent 应用做双向桥接：

- 页面启动后会主动发 `bridge:ready` 和 `bridge:request-context`
- 宿主应用可以把当前聊天上下文通过 `bridge:context-update` 推给网页
- 网页里用户发出的消息会回传 `bridge:user-message`
- 虚拟人回复和状态变化会回传 `bridge:persona-message`、`bridge:status`

如果宿主环境直接运行在浏览器里，可以这样拉起并注入上下文：

```js
window.mossMemoryBridge.launchAvatar("奶奶", {
  context: [
    "用户刚刚提到今天特别想奶奶",
    "当前主会话里正在聊小时候被鼓励的记忆"
  ]
});
```

虚拟人页打开后，宿主还可以继续推送最新上下文：

```js
window.mossMemoryBridge.pushContext([
  "用户刚补充：奶奶总说别着急，慢慢来"
]);
```

如果宿主想自己接管协议，也可以监听 `postMessage` / `BroadcastChannel`，消息类型见源码里的 `BridgeEventType`。这层桥的目的很简单：别让网页像失联分舱，主会话聊到哪，它就跟到哪。

## 参考

- Anthropic Skills: [https://www.anthropic.com/news/skills](https://www.anthropic.com/news/skills)
- Codex Skills: [https://developers.openai.com/codex/skills](https://developers.openai.com/codex/skills)
- Gemini `GEMINI.md`：[https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html](https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html)
- Gemini `@file.md` 导入：[https://google-gemini.github.io/gemini-cli/docs/core/memport.html](https://google-gemini.github.io/gemini-cli/docs/core/memport.html)
- Gemini `/memory` 命令：[https://google-gemini.github.io/gemini-cli/docs/cli/commands.html](https://google-gemini.github.io/gemini-cli/docs/cli/commands.html)
