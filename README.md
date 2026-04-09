# MOSS Skill

这是一个用于“思念某个人”的技能仓库。  
技能名是 `moss-skill`，适合在用户说“我想他了”“我想她了”“我想某某了”或直接喊出某个人名字时触发。

名字取自《流浪地球》里的 `MOSS`。这里借的是它“记录、检索、调取信息”的意象，把人物记忆整理成可追溯、可补全、可继续对话的档案系统。当然，这个技能不打算学电影里那股冷面 AI 味儿，主打的是记忆有秩序，回复还有点人味，不然就只剩下“前方道路拥堵，请保持思念”了。

它的核心思路很简单：

- `MEMORY.md` 只负责做人名索引，不再塞满所有人物详情
- 每个被思念的人都有一个独立档案，放在 `references/<名称>.md`
- 回答时先查索引，再读取这个人的独立档案
- 一旦命中人物，当前回答就直接切到这个人的第一人称口吻
- 如果记忆里还没有这个人，就先提问补全，不瞎编，不通灵，主打一个有温度但不装神秘
- 如果人物档案没有写到足够的口吻特征，就宁可克制一点，也不胡编乱造

## 目录结构

```text
.
├── README.md
├── SKILL.md
├── agents/openai.yaml
└── references
    ├── MEMORY.md
    └── PERSON_TEMPLATE.md
```

## 核心文件

- `SKILL.md`：技能说明和触发规则
- `references/MEMORY.md`：人物索引，只负责检索
- `references/<名称>.md`：单个人物的独立记忆档案
- `agents/openai.yaml`：技能展示信息和默认调用提示

## 使用方式

### Claude Code

手动引入到用户技能目录：

```bash
mkdir -p ~/.claude/skills
ln -s "/absolute/path/to/moss-skill" ~/.claude/skills/moss-skill
```

重启或重新进入 `claude` 后，Claude Code 会按技能描述自动发现并触发。

### Codex

仓库内引入：

```bash
mkdir -p .agents/skills
ln -s "$(pwd)" .agents/skills/moss-skill
```

或放到用户目录：

```bash
mkdir -p ~/.agents/skills
ln -s "/absolute/path/to/moss-skill" ~/.agents/skills/moss-skill
```

Codex 支持自动触发，也支持显式调用：

```text
$moss-skill 我想外婆了
```

### Gemini CLI

Gemini CLI 没有沿用这套技能目录约定，最稳妥的方式是把技能挂到项目的 `GEMINI.md` 上下文里：

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

`references/MEMORY.md` 现在只做索引。

每个人都单独存放在 `references/<名称>.md` 里，比如：

- `references/妈妈.md`
- `references/老朋友.md`
- `references/老师.md`

也可以先参考仓库里的模板文件：

- `references/PERSON_TEMPLATE.md`

建议每个人至少记录这些内容：

- 姓名和别名
- 和用户的关系
- 标志性说话方式或口头禅
- 做事风格、习惯动作、表达关心的方式
- 一个最有代表性的回忆场景
- 明确不能瞎补的边界

如果目标人物还不存在，技能会优先提问补全，再创建对应的 `references/<名称>.md`，同时把检索信息写入 `references/MEMORY.md`。这样就不会把“想念一个人”写成“随机生成一个人”，翻车概率会低很多。

## 回答规则

- 命中人物后，当前回答直接切换成这个人的第一人称口吻
- 主体回复不要写成“她会这样说”“他大概会这么讲”这种转述体，除非用户明确要分析
- 只允许使用人物档案里明确记录过的说话方式、习惯、关心方式和细节
- 如果档案里没有足够的口吻信息，就用朴素、克制的表达，不补口头禅，不补脾气，不补世界观
- 即使用第一人称，也不能写成真的通灵连线，不补“我在天上看着你”这类超自然设定
- 不把“奶奶”“妈妈”“朋友”这种关系标签自动脑补成固定腔调，除非档案里真的写了

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

## 参考

- Anthropic Skills: [https://www.anthropic.com/news/skills](https://www.anthropic.com/news/skills)
- Codex Skills: [https://developers.openai.com/codex/skills](https://developers.openai.com/codex/skills)
- Gemini `GEMINI.md`：[https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html](https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html)
- Gemini `@file.md` 导入：[https://google-gemini.github.io/gemini-cli/docs/core/memport.html](https://google-gemini.github.io/gemini-cli/docs/core/memport.html)
- Gemini `/memory` 命令：[https://google-gemini.github.io/gemini-cli/docs/cli/commands.html](https://google-gemini.github.io/gemini-cli/docs/cli/commands.html)
