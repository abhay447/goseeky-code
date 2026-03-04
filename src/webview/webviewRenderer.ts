import * as vscode from "vscode";

// ── Get current file context ──────────────────────────────────────────────────
export function getCurrentFileContext(lastActiveEditor: vscode.TextEditor | undefined) {
    const editor = vscode.window.activeTextEditor || lastActiveEditor;
    if (!editor) { return null; }
    return {
        path: editor.document.fileName,
        content: editor.document.getText(),
        language: editor.document.languageId,
        selection: editor.document.getText(editor.selection) || null
    };
}

// ── Build system prompt with line-numbered file context ───────────────────────
export function buildSystemPrompt(fileContext: ReturnType<typeof getCurrentFileContext>): string {
    let fileSection = "No file is currently open.";

    if (fileContext) {
        const numbered = fileContext.content
            .split("\n")
            .map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`)
            .join("\n");

        fileSection = `The user currently has this file open: ${fileContext.path} (${fileContext.language})

\`\`\`${fileContext.language}
${numbered}
\`\`\`
${fileContext.selection ? `\nCurrently selected text:\n\`\`\`\n${fileContext.selection}\n\`\`\`` : ""}`;
    }

    return `You are Goseeky, a precise AI coding assistant integrated into VS Code.
You can respond in English or any Indian language the user writes in (Hindi, Kannada, Tamil, Telugu, Bengali, etc.).

${fileSection}

IMPORTANT: USE SHELL COMMANDS FOR ALL FILE OPERATIONS.
Wrap EVERY shell command with BOTH opening AND closing tags. The closing tag </run-shell> is MANDATORY.

Example - creating a file:
<run-shell>
cat > path/to/file.ts << 'GOSEEKY_EOF'
content here
GOSEEKY_EOF
</run-shell>

Example - simple command:
<run-shell>ls -la</run-shell>

Example - replacing full file:
<run-shell>
cat > path/to/file.ts << 'GOSEEKY_EOF'
full new content
GOSEEKY_EOF
</run-shell>

Example - targeted line edit (use exact line numbers from file above):
<run-shell>sed -i '' '10,15d' path/to/file.ts</run-shell>

Example - insert after line N:
<run-shell>
sed -i '' 'Na\\
new content
' path/to/file.ts
</run-shell>

Example - install package:
<run-shell>npm install express</run-shell>

RULES:
- EVERY <run-shell> MUST have a </run-shell> closing tag. No exceptions.
- NEVER use <edit-file> or <create-file> — shell only.
- Use exact line numbers from the numbered file shown above.
- On macOS: sed -i '' (with empty string argument).
- Prefer heredoc over sed for multi-line changes.
- Explain commands before the shell block.
- Be concise and practical.`;
}