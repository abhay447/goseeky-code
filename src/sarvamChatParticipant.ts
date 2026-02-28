import * as vscode from "vscode";
import { SarvamClient, SarvamMessage } from "./sarvamClient";

// System prompt for the coding assistant
const SYSTEM_PROMPT = `You are Sarvam, an AI coding assistant with deep knowledge of Indian languages and software development.
You can respond in English or any Indian language the user prefers (Hindi, Kannada, Tamil, Telugu, Bengali, etc.).
When explaining code, be concise and practical. Use code blocks with language identifiers.
If the user writes in Hindi or another Indic language, respond in that same language.`;

export function registerSarvamChatParticipant(
  context: vscode.ExtensionContext,
  getClient: () => SarvamClient | null
) {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ) => {
    const client = getClient();
    if (!client) {
      response.markdown(
        "⚠️ Sarvam API key not set. Run **Sarvam: Set API Key** command first."
      );
      return;
    }

    // Build conversation history from context
    const messages: SarvamMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

    // Add previous turns
    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push({ role: "user", content: turn.prompt });
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .map((r) => (r instanceof vscode.ChatResponseMarkdownPart ? r.value.value : ""))
          .join("");
        if (text) messages.push({ role: "assistant", content: text });
      }
    }

    // Handle slash commands
    let userPrompt = request.prompt;

    if (request.command === "explain") {
      // /explain command - explain selected code
      const editor = vscode.window.activeTextEditor;
      const selection = editor?.selection;
      const code = editor?.document.getText(selection);
      if (code) {
        userPrompt = `Explain this code:\n\`\`\`${editor?.document.languageId}\n${code}\n\`\`\`\n${request.prompt}`;
      }
    } else if (request.command === "fix") {
      // /fix command - fix selected code
      const editor = vscode.window.activeTextEditor;
      const code = editor?.document.getText(editor?.selection);
      if (code) {
        userPrompt = `Fix bugs in this code and explain what was wrong:\n\`\`\`${editor?.document.languageId}\n${code}\n\`\`\`\n${request.prompt}`;
      }
    } else if (request.command === "translate") {
      // /translate - translate code comments to Hindi
      const config = vscode.workspace.getConfiguration("sarvam");
      const lang = config.get<string>("language", "hi-IN");
      userPrompt = `Translate the comments in this code to ${lang}: ${request.prompt}`;
    }

    messages.push({ role: "user", content: userPrompt });

    try {
      response.progress("Asking Sarvam AI...");

      const config = vscode.workspace.getConfiguration("sarvam");
      const temperature = config.get<number>("temperature", 0.2);

      // Stream the response
      for await (const chunk of client.chatStream(messages, { temperature })) {
        if (token.isCancellationRequested) break;
        response.markdown(chunk);
      }
    } catch (err: any) {
      response.markdown(`❌ Error: ${err.message}`);
    }
  };

  const participant = vscode.chat.createChatParticipant("sarvam.assistant", handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "sarvam-icon.png");

  // Register slash commands shown in UI
  participant.followupProvider = {
    provideFollowups(result, context, token) {
      return [
        { prompt: "", label: "$(sparkle) Explain selected code", command: "explain" },
        { prompt: "", label: "$(wrench) Fix selected code", command: "fix" },
        { prompt: "", label: "$(globe) Translate comments", command: "translate" },
      ];
    },
  };

  context.subscriptions.push(participant);
}