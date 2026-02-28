import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SarvamClient } from "./sarvamClient";

let sarvamClient: SarvamClient | null = null;
let lastActiveEditor: vscode.TextEditor | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log("Sarvam AI extension activated");

  // Load saved API key
  const savedKey = await context.secrets.get("sarvam.apiKey");
  if (savedKey) {
    sarvamClient = new SarvamClient(savedKey);
  }

  // Track last active editor (webview steals focus)
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      lastActiveEditor = editor;
    }
  }, null, context.subscriptions);

  // Register sidebar webview
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("sarvam.chatView", {
      resolveWebviewView(webviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = getChatHtml(context, webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg) => {

          // ── Basic chat ──────────────────────────────────────────────────
          if (msg.type === "ask") {
            try {
              if (!sarvamClient) {
                webviewView.webview.postMessage({
                  type: "error",
                  text: "API key not set. Run 'Sarvam: Set API Key' from Command Palette."
                });
                return;
              }

              const client = sarvamClient; // capture non-null reference
              const fileContext = getCurrentFileContext();
              const systemPrompt = buildSystemPrompt(fileContext);
              const config = vscode.workspace.getConfiguration("sarvam");
              const temperature = config.get<number>("temperature", 0.2);

              const reply = await sarvamClient.chat(
                [
                  { role: "system", content: systemPrompt },
                  { role: "user", content: msg.text }
                ],
                { temperature }
              );

              // Check for HIGH confidence edit — auto apply
              const editMatch = reply.match(/<edit-file confidence="(\w+)">([\s\S]*?)<\/edit-file>/);
              if (editMatch) {
                const confidence = editMatch[1];
                const inner = editMatch[2];
                const codeMatch = inner.match(/```(?:\w+)?\n([\s\S]*?)```/);
                const code = codeMatch ? codeMatch[1] : inner.trim();
                const cleanReply = reply.replace(/<edit-file[\s\S]*?<\/edit-file>/, "").trim();

                if (confidence === "HIGH") {
                  // Auto apply
                  const editor = vscode.window.activeTextEditor || lastActiveEditor;
                  if (editor) {
                    const edit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(
                      editor.document.positionAt(0),
                      editor.document.positionAt(editor.document.getText().length)
                    );
                    edit.replace(editor.document.uri, fullRange, code);
                    await vscode.workspace.applyEdit(edit);
                    webviewView.webview.postMessage({
                      type: "reply",
                      text: cleanReply,
                      autoApplied: true,
                      confidence: "HIGH"
                    });
                  } else {
                    // No editor open, fall back to manual
                    webviewView.webview.postMessage({
                      type: "reply",
                      text: cleanReply,
                      code,
                      confidence: "HIGH",
                      autoApplied: false
                    });
                  }
                } else {
                  // LOW confidence — let user decide
                  webviewView.webview.postMessage({
                    type: "reply",
                    text: cleanReply,
                    code,
                    confidence: "LOW",
                    autoApplied: false
                  });
                }
                return;
              }

              // Check for create-file
              const createMatch = reply.match(/<create-file name="([^"]+)">([\s\S]*?)<\/create-file>/);
              if (createMatch) {
                const filename = createMatch[1];
                const inner = createMatch[2];
                const codeMatch = inner.match(/```(?:\w+)?\n([\s\S]*?)```/);
                const code = codeMatch ? codeMatch[1] : inner.trim();
                const cleanReply = reply.replace(/<create-file[\s\S]*?<\/create-file>/, "").trim();
                webviewView.webview.postMessage({
                  type: "reply",
                  text: cleanReply,
                  createFile: { filename, code }
                });
                return;
              }

              // Plain reply
              webviewView.webview.postMessage({ type: "reply", text: reply });

            } catch (e: any) {
              webviewView.webview.postMessage({ type: "error", text: e.message });
            }
          }

          // ── Read current file ───────────────────────────────────────────
          if (msg.type === "readFile") {
            const ctx = getCurrentFileContext();
            if (ctx) {
              webviewView.webview.postMessage({ type: "fileContent", ...ctx });
            } else {
              webviewView.webview.postMessage({ type: "error", text: "No file open" });
            }
          }

          // ── Apply edit to current file ──────────────────────────────────
          if (msg.type === "applyEdit") {
            const editor = vscode.window.activeTextEditor || lastActiveEditor;

            if (!editor) {
              const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.joinPath(
                  vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(""),
                  "new-file.ts"
                ),
                filters: {
                  "TypeScript": ["ts"],
                  "JavaScript": ["js"],
                  "Python": ["py"],
                  "All Files": ["*"]
                }
              });
              if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.code, "utf8"));
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
                lastActiveEditor = vscode.window.activeTextEditor;
                webviewView.webview.postMessage({ type: "editApplied" });
              }
              return;
            }

            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
              editor.document.positionAt(0),
              editor.document.positionAt(editor.document.getText().length)
            );
            edit.replace(editor.document.uri, fullRange, msg.code);
            await vscode.workspace.applyEdit(edit);
            webviewView.webview.postMessage({ type: "editApplied" });
          }

          // ── Create new file ─────────────────────────────────────────────
          if (msg.type === "createFile") {
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.joinPath(
                vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(""),
                msg.filename || "new-file.ts"
              ),
              filters: { "All Files": ["*"] }
            });
            if (uri) {
              await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.code, "utf8"));
              const doc = await vscode.workspace.openTextDocument(uri);
              await vscode.window.showTextDocument(doc);
              lastActiveEditor = vscode.window.activeTextEditor;
              webviewView.webview.postMessage({ type: "editApplied" });
            }
          }

          // ── Open file picker ────────────────────────────────────────────
          if (msg.type === "openFile") {
            const uris = await vscode.window.showOpenDialog({ canSelectMany: false });
            if (uris && uris[0]) {
              const doc = await vscode.workspace.openTextDocument(uris[0]);
              await vscode.window.showTextDocument(doc);
              lastActiveEditor = vscode.window.activeTextEditor;
              webviewView.webview.postMessage({
                type: "fileContent",
                path: uris[0].fsPath,
                content: doc.getText(),
                language: doc.languageId
              });
            }
          }

          // ── List workspace files ────────────────────────────────────────
          if (msg.type === "listFiles") {
            const files = await vscode.workspace.findFiles("**/*", "**/node_modules/**", 50);
            const names = files.map(f => vscode.workspace.asRelativePath(f));
            webviewView.webview.postMessage({ type: "fileList", files: names });
          }

        });
      }
    })
  );

  // ── Command: Set API Key ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("sarvam.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        prompt: "Enter your Sarvam AI API key",
        password: true,
        placeHolder: "Get it from https://dashboard.sarvam.ai"
      });
      if (key) {
        await context.secrets.store("sarvam.apiKey", key);
        sarvamClient = new SarvamClient(key);
        vscode.window.showInformationMessage("✅ Sarvam API key saved!");
      }
    })
  );

  // ── Command: Quick Ask ────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("sarvam.ask", async () => {
      if (!sarvamClient) {
        vscode.window.showErrorMessage("Set your Sarvam API key first!");
        await vscode.commands.executeCommand("sarvam.setApiKey");
        return;
      }

      const question = await vscode.window.showInputBox({
        prompt: "Ask Sarvam AI anything",
        placeHolder: "e.g. 'Write a REST API in FastAPI' or 'REST API कैसे बनाएं?'"
      });

      if (!question) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Sarvam AI is thinking..." },
        async () => {
          const answer = await sarvamClient!.chat([
            { role: "system", content: "You are a helpful coding assistant. Be concise." },
            { role: "user", content: question }
          ]);

          const doc = await vscode.workspace.openTextDocument({
            content: `# Sarvam AI Response\n\n**Question:** ${question}\n\n---\n\n${answer}`,
            language: "markdown"
          });
          vscode.window.showTextDocument(doc);
        }
      );
    })
  );

  // ── Command: Explain Selected Code ───────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("sarvam.explainCode", async () => {
      if (!sarvamClient) {
        vscode.window.showErrorMessage("Set your Sarvam API key first!");
        return;
      }

      const editor = vscode.window.activeTextEditor || lastActiveEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor found");
        return;
      }

      const selection = editor.selection;
      const code = editor.document.getText(selection);
      if (!code) {
        vscode.window.showWarningMessage("Please select some code first");
        return;
      }

      const lang = editor.document.languageId;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Explaining code..." },
        async () => {
          const explanation = await sarvamClient!.chat([
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

  return `You are Sarvam, a helpful AI coding assistant integrated into VS Code.
You can respond in English or any Indian language the user writes in.

${fileSection}

IMPORTANT RULES:

1. When asked to CREATE a new file, end your response with:
<create-file name="filename.ext">
\`\`\`language
code here
\`\`\`
</create-file>

2. When editing the existing open file, wrap your code with a confidence tag:
<edit-file confidence="HIGH">
\`\`\`language
full updated code here
\`\`\`
</edit-file>

Use confidence="HIGH" when:
- The request is clear and unambiguous
- You are replacing/adding a specific function or fix
- The user says "fix", "add", "refactor", "update" something specific

Use confidence="LOW" when:
- The request is vague or open-ended
- You are unsure which part to change
- The change could break other parts

3. Always use code blocks with the correct language identifier.
4. Be concise and practical.`;
}

function getChatHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const htmlPath = path.join(context.extensionPath, "src", "webview", "chat.html");
  return fs.readFileSync(htmlPath, "utf8");
}

export function deactivate() { }