import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { AIProvider, SarvamProvider, GeminiProvider } from "./providers";
import { handleMessage } from "./webview/webviewHandler";

let activeProvider: AIProvider | null = null;
let activeProviderName: "sarvam" | "gemini" = "sarvam";
let lastActiveEditor: vscode.TextEditor | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log("Goseeky Code extension activated");

  // Load saved keys on startup — use whichever is available
  const sarvamKey = await context.secrets.get("goseeky.sarvam.apiKey");
  const geminiKey = await context.secrets.get("goseeky.gemini.apiKey");

  if (sarvamKey) {
    activeProvider = new SarvamProvider(sarvamKey);
    activeProviderName = "sarvam";
  } else if (geminiKey) {
    activeProvider = new GeminiProvider(geminiKey);
    activeProviderName = "gemini";
  }

  // Track last active editor (webview steals focus)
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      lastActiveEditor = editor;
    }
  }, null, context.subscriptions);

  // ── Register sidebar webview ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("goseeky-code.chatView", {
      resolveWebviewView(webviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = getChatHtml(context, webviewView.webview);
        webviewView.webview.onDidReceiveMessage(async (msg) => handleMessage(activeProvider, activeProviderName, context, lastActiveEditor, webviewView, msg));
      }
    })
  );

  // ── Command: Set API Key ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("goseeky-code.setApiKey", async () => {
      const provider = await vscode.window.showQuickPick(
        [
          { label: "$(sparkle) Sarvam AI", id: "sarvam", description: "Best for Indic languages" },
          { label: "$(globe) Gemini", id: "gemini", description: "Google's Gemini 2.0 Flash" }
        ],
        { placeHolder: "Which provider's API key do you want to set?" }
      );
      if (!provider) return;

      const key = await vscode.window.showInputBox({
        prompt: `Enter your ${provider.id} API key`,
        password: true,
        placeHolder: provider.id === "sarvam"
          ? "Get it from https://dashboard.sarvam.ai"
          : "Get it from https://aistudio.google.com"
      });

      if (key) {
        await context.secrets.store(`goseeky.${provider.id}.apiKey`, key);
        activeProviderName = provider.id as "sarvam" | "gemini";
        activeProvider = provider.id === "sarvam"
          ? new SarvamProvider(key)
          : new GeminiProvider(key);
        vscode.window.showInformationMessage(`✅ ${provider.id} API key saved and activated!`);
      }
    })
  );

  // ── Command: Switch Provider ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("goseeky-code.switchProvider", async () => {
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: "$(sparkle) Sarvam AI",
            description: activeProviderName === "sarvam" ? "● active" : "",
            detail: "sarvam-m — best for Indic languages",
            id: "sarvam"
          },
          {
            label: "$(globe) Gemini",
            description: activeProviderName === "gemini" ? "● active" : "",
            detail: "gemini-2.5-flash — Google's model",
            id: "gemini"
          },
        ],
        { placeHolder: "Select AI provider" }
      );

      if (!pick) return;

      const key = await context.secrets.get(`goseeky.${pick.id}.apiKey`);
      if (!key) {
        const setNow = await vscode.window.showWarningMessage(
          `No API key found for ${pick.id}. Set it now?`,
          "Yes", "No"
        );
        if (setNow === "Yes") {
          await vscode.commands.executeCommand("goseeky-code.setApiKey");
        }
        return;
      }

      activeProviderName = pick.id as "sarvam" | "gemini";
      activeProvider = pick.id === "sarvam"
        ? new SarvamProvider(key)
        : new GeminiProvider(key);

      vscode.window.showInformationMessage(`✅ Switched to ${pick.id}`);
    })
  );

  // ── Command: Quick Ask ────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("goseeky-code.ask", async () => {
      if (!activeProvider) {
        vscode.window.showErrorMessage("Set your API key first!");
        await vscode.commands.executeCommand("goseeky-code.setApiKey");
        return;
      }

      const question = await vscode.window.showInputBox({
        prompt: "Ask Goseeky AI anything",
        placeHolder: "e.g. 'Write a REST API in FastAPI' or 'REST API कैसे बनाएं?'"
      });

      if (!question) return;

      const client = activeProvider;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Goseeky AI is thinking..." },
        async () => {
          const answer = await client.chat([
            { role: "system", content: "You are a helpful coding assistant. Be concise." },
            { role: "user", content: question }
          ]);
          const doc = await vscode.workspace.openTextDocument({
            content: `# Goseeky AI Response\n\n**Question:** ${question}\n\n---\n\n${answer}`,
            language: "markdown"
          });
          vscode.window.showTextDocument(doc);
        }
      );
    })
  );

  // ── Command: Explain Selected Code ───────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("goseeky-code.explainCode", async () => {
      if (!activeProvider) {
        vscode.window.showErrorMessage("Set your API key first!");
        return;
      }

      const editor = vscode.window.activeTextEditor || lastActiveEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor found");
        return;
      }

      const code = editor.document.getText(editor.selection);
      if (!code) {
        vscode.window.showWarningMessage("Please select some code first");
        return;
      }

      const lang = editor.document.languageId;
      const client = activeProvider;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Explaining code..." },
        async () => {
          const explanation = await client.chat([
            {
              role: "system",
              content: "You are a code explainer. Explain the given code clearly with a line-by-line breakdown if needed."
            },
            {
              role: "user",
              content: `Explain this ${lang} code:\n\`\`\`${lang}\n${code}\n\`\`\``
            }
          ]);
          const doc = await vscode.workspace.openTextDocument({
            content: `# Code Explanation\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n---\n\n${explanation}`,
            language: "markdown"
          });
          vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    })
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCurrentFileContext() {
  const editor = vscode.window.activeTextEditor || lastActiveEditor;
  if (!editor) return null;
  return {
    path: editor.document.fileName,
    content: editor.document.getText(),
    language: editor.document.languageId,
    selection: editor.document.getText(editor.selection) || null
  };
}

function buildSystemPrompt(fileContext: ReturnType<typeof getCurrentFileContext>): string {
  const fileSection = fileContext
    ? `The user currently has this file open (${fileContext.language}):
\`\`\`${fileContext.language}
${fileContext.content}
\`\`\`
${fileContext.selection ? `\nSelected text:\n\`\`\`\n${fileContext.selection}\n\`\`\`` : ""}`
    : "No file is currently open.";

  return `You are Goseeky, a helpful AI coding assistant integrated into VS Code.
You can respond in English or any Indian language the user writes in (Hindi, Kannada, Tamil, Telugu, Bengali, etc.).

${fileSection}

IMPORTANT RULES:
- When the user asks you to CREATE a new file, end your response with this exact format:
<create-file name="filename.ext">
\`\`\`language
code here
\`\`\`
</create-file>

- When editing the existing open file, wrap your code with a confidence tag:
<edit-file confidence="HIGH">
\`\`\`language
full updated code here
\`\`\`
</edit-file>

Use confidence="HIGH" when the request is clear and unambiguous.
Use confidence="LOW" when the request is vague or you are unsure.

- Always use code blocks with the correct language identifier.
- Be concise and practical.`;
}

function getChatHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const htmlPath = path.join(context.extensionPath, "src", "webview", "chat.html");
  return fs.readFileSync(htmlPath, "utf8");
}

export function deactivate() { }