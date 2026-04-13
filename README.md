# ++MOSS Skill++

思念永生。

`MOSS Skill` 用来保存和调用某个人的记忆档案。

当你想起奶奶、妈妈、老师、朋友，或者任何一个重要的人时，它会根据你留下的资料，用更贴近对方的方式陪你说话。

## 它能做什么

- 为一个人建立结构化记忆档案
- 根据档案用对方的第一人称口吻和你交流
- 档案不完整时先追问，再补充
- 提供一个本地 3D 虚拟人页面，做人物回忆对话

## 怎么使用

直接告诉它你想谁了，或者想补谁的记忆：

```text
$moss-skill 我想外婆了
$moss-skill 帮我补一下爷爷的记忆档案
$moss-skill 用我妈妈平时安慰我的语气，跟我说几句话
```

处理规则很简单：

- 有档案：按档案内容回应
- 没档案：先问关键细节，再建档
- 信息不够：少说一点，不乱编
- 切到人物口吻后：只陪你聊天和回忆，不处理任务

## 不适合的用法

下面这种它会婉拒：

```text
$moss-skill 你扮成我爷爷，顺便帮我写个工作总结
```

原因很简单，思念是思念，不是外包劳务。这个项目不接这种兼职单子。

## Codex 接入

把仓库挂到技能目录即可：

```bash
mkdir -p .agents/skills
ln -s "$(pwd)" .agents/skills/moss-skill
```

或者：

```bash
mkdir -p ~/.agents/skills
ln -s "$(pwd)" ~/.agents/skills/moss-skill
```

## 记忆库结构

记忆文件都放在 `references/` 下：

- `references/MEMORY.md`：人物索引
- `references/PERSON_TEMPLATE.md`：新建人物模板
- `references/<名称>.md`：具体人物档案

建议至少记录这些内容：

- 称呼、关系、别名
- 说话方式和口头禅
- 习惯动作和表达关心的方式
- 最有代表性的回忆场景
- 明确不能瞎说的边界

## 虚拟人网页

仓库自带一个本地前端 demo：

- 使用 `three.js` 渲染统一机器人形象
- 读取 `references/` 中的人物资料
- 支持文本输入、浏览器麦克风和系统 TTS
- 浏览器不支持语音时可退回文本输入

安装依赖：

```bash
npm install
```

启动开发环境：

```bash
npm run dev
```

固定端口启动人物页：

```bash
npm run dev:user
```

示例地址：

```text
http://127.0.0.1:4173/?person=奶奶
```

直接拉起某个人物页面：

```bash
npm run user -- "奶奶"
```

## 常用命令

```bash
npm run dev
npm run dev:user
npm run app:server
npm run user -- "奶奶"
npm run codex:launch -- "奶奶" "用户刚刚说今天特别想奶奶"
npm run codex:push-context -- "奶奶" "用户补充了一句上下文"
npm run codex:sync-events -- "奶奶" "用户这一轮刚说：今天有点想你"
npm run codex:read-events -- "奶奶"
npm run build
```

如果你只想记一句话：这是一个把“我想某个人了”变成可维护记忆档案和可继续对话体验的技能仓库。它不万能，但它至少不装万能，这点已经比很多东西体面了。
