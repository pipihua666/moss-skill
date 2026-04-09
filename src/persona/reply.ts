import type {
  ConversationTurn,
  PersonaReplyInput,
  PersonaReplyResult,
  PersonProfile
} from "../types";

const TASK_REQUEST_PATTERN =
  /(帮我|替我|给我|写(个|一篇|一下)|做(个|一下)|生成|总结|计划|代码|修|改|排期|交付|文档|方案)/;

function choosePrompt(profile: PersonProfile): string {
  return profile.speakingStyle.catchphrases[0]
    || profile.speakingStyle.commonWords[0]
    || "";
}

function chooseCare(profile: PersonProfile): string {
  if (profile.behaviorStyle.showCare !== "待确认") {
    return profile.behaviorStyle.showCare;
  }

  return `${profile.howUserRefersToThem || profile.name}在这儿陪你说说话`;
}

function chooseMemory(profile: PersonProfile): string {
  if (profile.keyMemories.smallDetails !== "待确认") {
    return profile.keyMemories.smallDetails;
  }

  if (profile.keyMemories.memorableScene !== "待确认") {
    return profile.keyMemories.memorableScene;
  }

  return "";
}

function buildPersonaText(profile: PersonProfile, input: string, turns: ConversationTurn[]): PersonaReplyResult {
  const opener = choosePrompt(profile);
  const care = chooseCare(profile);
  const memory = chooseMemory(profile);
  const latestUserTurn = [...turns].reverse().find((turn) => turn.speaker === "user")?.text ?? input;
  const boundaryTriggered = TASK_REQUEST_PATTERN.test(input);

  if (boundaryTriggered) {
    return {
      text: `${opener ? `${opener}，` : ""}我先不帮你忙那些任务活儿啦。${care}，你跟我说说你现在最想起我的哪一点，我们慢慢聊。`,
      boundaryTriggered: true,
      suggestedFollowUp: profile.openQuestions[0]
    };
  }

  if (/想你|想您|想你了|想您了/.test(input)) {
    return {
      text: `${opener ? `${opener}，` : ""}我知道你想我了。${care}。${memory ? `你不是一直记着我那点${memory}吗，记得就好。` : "你愿意开口叫我，我就已经听见了。"}`
        .replace(/\s+/g, ""),
      boundaryTriggered: false,
      suggestedFollowUp: profile.openQuestions[0]
    };
  }

  if (/你还好吗|最近好吗|好吗/.test(input)) {
    return {
      text: `${opener ? `${opener}，` : ""}我这边没什么，你别替我操心。${care}。你倒跟我说说，今天是不是又把心事憋着了？`,
      boundaryTriggered: false,
      suggestedFollowUp: profile.openQuestions[0]
    };
  }

  const gentleFollowUp = profile.openQuestions[0]
    ? `你再跟我说说，${profile.openQuestions[0]}`
    : "你继续跟我说，我在听。";

  return {
    text: `${opener ? `${opener}，` : ""}${care}。${memory ? `我让你记住的，大概就是${memory}。` : ""}刚才你说“${latestUserTurn}”，我听见了。${gentleFollowUp}`
      .replace(/\s+/g, ""),
    boundaryTriggered: false,
    suggestedFollowUp: profile.openQuestions[0]
  };
}

export async function generatePersonaReply(input: PersonaReplyInput): Promise<PersonaReplyResult> {
  return buildPersonaText(input.profile, input.input, input.turns);
}
