import * as vscode from "vscode";
import { AIProvider, ChatHistoryRecord, ChatOptions } from "./types";

const MAX_HISTORY_TOKENS = 10000;
const MAX_HISTORY_MESSAGES = MAX_HISTORY_TOKENS / 10;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}


export class ChatHistoryManager {
  private history: ChatHistoryRecord[] = [];
  private storageKey: string;

  constructor(private context: vscode.ExtensionContext, private historyKey: string = "goseeky.chatHistory") {
    this.storageKey = historyKey;
    this.history = this.context.globalState.get<ChatHistoryRecord[]>(this.storageKey, []);
  }

  clear() {
    this.history = [];
    this.context.globalState.update(this.storageKey, []);
  }

  getHistory(): ChatHistoryRecord[] {
    let remainingTokens = MAX_HISTORY_TOKENS;

    const trimmed: ChatHistoryRecord[] = [];
    const recent = this.history.slice(-MAX_HISTORY_MESSAGES);

    for (let i = recent.length - 1; i >= 0; i--) {
      const msg = recent[i];
      const tokens = estimateTokens(msg.userQuery) + estimateTokens(msg.agentResponse);
      if (remainingTokens - tokens < 0) { break; }
      trimmed.unshift(msg);
      remainingTokens -= tokens;
    }

    return trimmed;
  }

  async addHistory(
    client: AIProvider,
    userQuery: string,
    agentResponse: string,
    options?: ChatOptions
  ): Promise<string> {
    let summarizedReply = agentResponse;
    if (agentResponse && agentResponse.length > 1000) {
      summarizedReply = await client.chat(
        [
          {
            role: "system", content: `
          You are a conversation summarization assistant, you will be given a user and corresponding agent response.
          Return the summarized agent response in less than 1000 characters. ` },
          { role: "user", content: `For the user query "${userQuery}", the agent response is: "${agentResponse}"` },
        ],
        options
      );
    }
    this.history.push({ userQuery, agentResponse: summarizedReply , timestamp: Date.now() });
    this.context.globalState.update(this.storageKey, this.history);
    return summarizedReply;
  }
}