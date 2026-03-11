import * as vscode from "vscode";
import { AIProvider, ChatMessage, ChatOptions } from "./types";


const MAX_TOKENS = 3000; // conservative — leaves room for system prompt + response
const MAX_MESSAGES = MAX_TOKENS/300;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Strip reasoning blocks from model output ──────────────────────────────────
function stripThinkingBlocks(text: string): string {
  // Remove fully closed <think>...</think> blocks
  let result = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");

  // For unclosed <think> — just remove the opening tag, keep the content after it
  result = result.replace(/<think>/gi, "").replace(/<thinking>/gi, "");

  return result.trim();
}

// ── Truncate a single message if it's too long ────────────────────────────────
function truncateMessage(msg: ChatMessage, maxTokens: number): ChatMessage {
  const tokens = estimateTokens(msg.content);
  if (tokens <= maxTokens) { return msg; }
  const maxChars = maxTokens * 4;
  return { ...msg, content: msg.content.slice(0, maxChars) + "\n...[truncated]" };
}

export class ChatManager {
  private history: ChatMessage[] = [];
  private readonly storageKey = "goseeky.chatHistory";

  constructor(private context: vscode.ExtensionContext) {
    this.history = this.context.globalState.get<ChatMessage[]>(this.storageKey, []);
  }

  clear() {
    this.history = [];
    this.context.globalState.update(this.storageKey, []);
  }

  getHistory(systemMsg: ChatMessage, userMsg: ChatMessage): ChatMessage[] {
    // Truncate system prompt if enormous (e.g. large file context)
    const safeSystemMsg = truncateMessage(systemMsg, MAX_TOKENS/2);
    // Truncate user message if enormous (e.g. large results feed-back)
    const safeUserMsg = truncateMessage(userMsg, MAX_TOKENS/2);

    const systemTokens = estimateTokens(safeSystemMsg.content);
    const userTokens = estimateTokens(safeUserMsg.content);
    const reservedForResponse = MAX_TOKENS/3;
    let remainingTokens = MAX_TOKENS - systemTokens - userTokens - reservedForResponse;

    const trimmed: ChatMessage[] = [];
    const recent = this.history.slice(-MAX_MESSAGES);

    for (let i = recent.length - 1; i >= 0; i--) {
      const msg = recent[i];
      const tokens = estimateTokens(msg.content);
      if (remainingTokens - tokens < 0) { break; }
      trimmed.unshift(msg);
      remainingTokens -= tokens;
    }

    // Ensure history starts with a user message
    while (trimmed.length > 0 && trimmed[0].role !== "user") {
      trimmed.shift();
    }

    return [safeSystemMsg, ...trimmed, safeUserMsg];
  }

  async chat(
    client: AIProvider,
    systemMsg: ChatMessage,
    userMsg: ChatMessage,
    options?: ChatOptions
  ): Promise<string> {
    const messages = this.getHistory(systemMsg, userMsg);
    const rawReply = await client.chat(messages, options);
    const reply = stripThinkingBlocks(rawReply);

    this.history.push(userMsg);
    this.history.push({ role: "assistant", content: reply });

    await this.context.globalState.update(this.storageKey, this.history);

    return reply;
  }

  size(): number {
    return this.history.length;
  }
}