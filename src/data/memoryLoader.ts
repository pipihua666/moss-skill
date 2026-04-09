import type { MemoryIndex, PersonProfile } from "../types";

const indexModules = import.meta.glob("../../references/MEMORY.md", {
  eager: true,
  query: "?raw",
  import: "default"
});

const profileModules = import.meta.glob("../../references/*.md", {
  eager: true,
  query: "?raw",
  import: "default"
});

const UNKNOWN = "待确认";

function cleanValue(value: string | undefined): string {
  if (!value) {
    return UNKNOWN;
  }

  const normalized = value.replace(/`/g, "").trim();
  return normalized.length > 0 ? normalized : UNKNOWN;
}

function parseListValue(value: string): string[] {
  if (value === UNKNOWN) {
    return [];
  }

  return value
    .split(/[、，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMemoryIndex(markdown: string): MemoryIndex[] {
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

function extractSection(markdown: string, title: string): string[] {
  const lines = markdown.split("\n");
  const sectionLines: string[] = [];
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

function extractField(lines: string[], key: string): string {
  const prefix = `- ${key}:`;
  const line = lines.find((item) => item.startsWith(prefix));

  return cleanValue(line?.slice(prefix.length));
}

function extractNestedList(lines: string[], key: string): string[] {
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

  const items: string[] = [];

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

function parsePersonProfile(markdown: string): PersonProfile {
  const lines = markdown.split("\n");
  const title = lines.find((line) => line.startsWith("# "))?.replace("# ", "").trim() ?? "未命名人物";

  const rootValue = (key: string) => extractField(lines, key);
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

function getIndexMarkdown(): string {
  const entry = Object.values(indexModules)[0];
  if (typeof entry !== "string") {
    throw new Error("未找到记忆索引文件");
  }

  return entry;
}

export async function loadMemoryIndex(): Promise<MemoryIndex[]> {
  return parseMemoryIndex(getIndexMarkdown());
}

export async function loadPersonProfile(personId: string): Promise<PersonProfile> {
  const profiles = Object.entries(profileModules)
    .filter(([path]) => !path.endsWith("MEMORY.md") && !path.endsWith("PERSON_TEMPLATE.md"))
    .map(([path, raw]) => ({
      path,
      profile: parsePersonProfile(String(raw))
    }));

  const normalizedId = decodeURIComponent(personId).trim();
  const match = profiles.find(({ profile, path }) => {
    const fileName = path.split("/").pop()?.replace(".md", "") ?? "";
    return (
      profile.name === normalizedId ||
      fileName === normalizedId ||
      profile.aliases.includes(normalizedId)
    );
  });

  if (!match) {
    throw new Error(`未找到人物档案：${normalizedId}`);
  }

  return match.profile;
}
