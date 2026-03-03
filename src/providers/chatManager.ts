import * as vscode from "vscode";
import { AIProvider, ChatMessage, ChatOptions } from "./types";

const MAX_MESSAGES = 20;
const MAX_TOKENS = 30000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ChatManager {
  private history: ChatMessage[] = [];
  private readonly storageKey = "goseeky.chatHistory";

  constructor(private context: vscode.ExtensionContext) {
    // Load persisted history on startup
    this.history = this.context.globalState.get<ChatMessage[]>(this.storageKey, []);
  }

  clear() {
    this.history = [];
    this.context.globalState.update(this.storageKey, []);
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

    this.history.push(userMsg);
    this.history.push({ role: "assistant", content: reply });

    // Persist to globalState
    await this.context.globalState.update(this.storageKey, this.history);

    return reply;
  }

  size(): number {
    return this.history.length;
  }
}