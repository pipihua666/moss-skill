import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UNKNOWN = "待确认";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const REFERENCES_DIR = path.join(PROJECT_ROOT, "references");
const MEMORY_INDEX_FILE = path.join(REFERENCES_DIR, "MEMORY.md");

function cleanValue(value) {
  if (!value) {
    return UNKNOWN;
  }

  const normalized = String(value).replace(/`/g, "").trim();
  return normalized.length > 0 ? normalized : UNKNOWN;
}

function parseListValue(value) {
  if (value === UNKNOWN) {
    return [];
  }

  return String(value)
    .split(/[、，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractSection(markdown, title) {
  const lines = markdown.split("\n");
  const sectionLines = [];
  let collecting = false;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      collecting = line.replace("## ", "").trim() === title;
      continue;
    }

    if (collecting) {
      sectionLines.push(line);
    }
  }

  return sectionLines;
}

function extractField(lines, key) {
  const prefix = `- ${key}:`;
  const line = lines.find((item) => item.startsWith(prefix));
  return cleanValue(line?.slice(prefix.length));
}

function extractNestedList(lines, key) {
  const prefix = `- ${key}:`;
  const startIndex = lines.findIndex((item) => item.startsWith(prefix));

  if (startIndex === -1) {
    return [];
  }

  const startLine = lines[startIndex];
  const inlineValue = cleanValue(startLine.slice(prefix.length));
  if (inlineValue !== UNKNOWN) {
    return parseListValue(inlineValue);
  }

  const items = [];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith("- ") && !line.startsWith("  - ")) {
      break;
    }

    if (line.startsWith("  - ")) {
      items.push(cleanValue(line.replace("  - ", "")));
    }
  }

  return items;
}

function parseMemoryIndex(markdown) {
  const rows = markdown
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .slice(2);

  return rows
    .map((row) => row.split("|").map((part) => part.trim()))
    .filter((parts) => parts.length >= 8)
    .map((parts) => ({
      name: cleanValue(parts[1]),
      aliases: parseListValue(cleanValue(parts[2])),
      file: cleanValue(parts[3]),
      relationship: cleanValue(parts[4]),
      status: cleanValue(parts[5]),
      lastUpdated: cleanValue(parts[6])
    }));
}

function parsePersonProfile(markdown) {
  const lines = markdown.split("\n");
  const title = lines.find((line) => line.startsWith("# "))?.replace("# ", "").trim() ?? "未命名人物";
  const rootValue = (key) => extractField(lines, key);
  const speakingSection = extractSection(markdown, "说话方式");
  const behaviorSection = extractSection(markdown, "做事与行为方式");
  const memorySection = extractSection(markdown, "关键回忆");
  const boundarySection = extractSection(markdown, "边界与待补全");

  return {
    name: title,
    aliases: parseListValue(rootValue("aliases")),
    relationship: rootValue("relationship"),
    howUserRefersToThem: rootValue("how_user_refers_to_them"),
    status: rootValue("status"),
    lastUpdated: rootValue("last_updated"),
    speakingStyle: {
      catchphrases: parseListValue(extractField(speakingSection, "catchphrases")),
      tone: extractField(speakingSection, "tone"),
      rhythm: extractField(speakingSection, "rhythm"),
      commonWords: parseListValue(extractField(speakingSection, "common_words"))
    },
    behaviorStyle: {
      habits: parseListValue(extractField(behaviorSection, "habits")),
      gestures: parseListValue(extractField(behaviorSection, "gestures")),
      decisionPattern: extractField(behaviorSection, "decision_pattern"),
      showCare: extractField(behaviorSection, "show_care"),
      conflictStyle: extractField(behaviorSection, "conflict_style")
    },
    keyMemories: {
      memorableScene: extractField(memorySection, "memorable_scene"),
      linkedObjectOrPlace: extractField(memorySection, "linked_object_or_place"),
      smallDetails: extractField(memorySection, "small_details")
    },
    boundaries: extractField(boundarySection, "boundaries"),
    openQuestions: extractNestedList(boundarySection, "open_questions"),
    rawMarkdown: markdown
  };
}

export function getProjectRoot() {
  return PROJECT_ROOT;
}

export function loadMemoryIndex() {
  return parseMemoryIndex(fs.readFileSync(MEMORY_INDEX_FILE, "utf8"));
}

export function loadPersonProfile(personId) {
  const normalizedId = decodeURIComponent(String(personId ?? "")).trim();
  const index = loadMemoryIndex();
  const match = index.find((item) => item.name === normalizedId || item.aliases.includes(normalizedId));

  if (!match) {
    throw new Error(`未找到人物档案：${normalizedId}`);
  }

  const fileName = match.file.replace(/^`|`$/g, "");
  const absoluteFile = path.isAbsolute(fileName)
    ? fileName
    : path.join(PROJECT_ROOT, fileName.replace(/^references[\\/]/, "references/"));

  return parsePersonProfile(fs.readFileSync(absoluteFile, "utf8"));
}

export function buildPersonaDeveloperInstructions(profile) {
  return [
    "你正在为 MOSS 思念陪伴项目处理一位被记住的人物对话。",
    "只允许依据下面的人物档案回复，不要额外查资料，不要虚构经历，不要把自己说成 AI、模拟体、分身或扮演者。",
    "回复要求：中文、第一人称、克制、温和；如果档案信息不足，就少说一点，不乱编。",
    "禁止把自己变成任务助手；如果用户让你写文档、做计划、写代码、处理待办，要婉拒并把话题拉回回忆与陪伴。",
    "不要暗示超自然联系，不要假装无所不知。",
    "",
    "人物档案如下：",
    profile.rawMarkdown
  ].join("\n");
}
