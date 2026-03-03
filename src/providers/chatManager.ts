import { AIProvider, ChatMessage, ChatOptions } from "./types";

const MAX_MESSAGES = 20;
const MAX_TOKENS = 30000;

// Rough token estimator: ~4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ChatManager {
  private history: ChatMessage[] = [];

  clear() {
    this.history = [];
  }

  getHistory(systemMsg: ChatMessage, userMsg: ChatMessage): ChatMessage[] {
    const systemTokens = estimateTokens(systemMsg.content);
    const userTokens = estimateTokens(userMsg.content);
    let remainingTokens = MAX_TOKENS - systemTokens - userTokens;

    const trimmed: ChatMessage[] = [];
    const recent = this.history.slice(-MAX_MESSAGES);

    for (let i = recent.length - 1; i >= 0; i--) {
      const msg = recent[i];
      const tokens = estimateTokens(msg.content);
      if (remainingTokens - tokens < 0) break;
      trimmed.unshift(msg);
      remainingTokens -= tokens;
    }

    // Ensure history starts with a user message
    while (trimmed.length > 0 && trimmed[0].role !== "user") {
      trimmed.shift();
    }

    return [
      systemMsg,
      ...trimmed,
      userMsg
    ];
  }

  async chat(
    client: AIProvider,
    systemMsg: ChatMessage,
    userMsg: ChatMessage,
    options?: ChatOptions
  ): Promise<string> {
    const messages = this.getHistory(systemMsg, userMsg);
    const reply = await client.chat(messages, options);

    // Only store user/assistant pairs, not system
    this.history.push(userMsg);
    this.history.push({ role: "assistant", content: reply });

    return reply;
  }

  size(): number {
    return this.history.length;
  }
}