import { AgentTool } from "./types";
import { runShell } from "../utils/shellUtils";
import { AIProvider } from "../providers";
import * as vscode from "vscode";
import * as os from "os";
import path from "path";
import { promises as fs } from "fs";

export function getExtensionContextInfo() {
    // 1. Get Current Folder (Primary Workspace Root)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const currentFolder = workspaceFolders ? workspaceFolders[0].uri.fsPath : 'No workspace open';

    // 2. Operating System Info
    const operatingSystem = `${os.type()} (${os.platform()}) ${os.release()}`;

    // 3. Shell (Fallback logic for Windows vs Unix)
    const shell = process.env.SHELL || process.env.ComSpec || 'Unknown Shell';

    // 4. DateTime
    const dateTime = new Date().toLocaleString();

    return {
        "current_working_directory" : currentFolder,
        "operating_system": operatingSystem,
        "shell" : shell,
        "date_time": dateTime
    };
}


export class ShellExecute implements AgentTool {
  name: string
  toolDescription: string
  constructor() {
    this.name = 'ShellExecute'
    this.toolDescription = `
      This is the primary tool for inspecting , reading, finding and editing code wrt user query.
      You should also use this tool for any os or filesystem related interactions.
      If a .git folder is present then restrict all interactions to git visible files only .
      Make sure shell_script egenrated is a valid string wrt JSON Serialization and escaping rules.
      Here is the extension context info that might be useful for you to construct shell commands:
      ${JSON.stringify(getExtensionContextInfo(), null, 2)}

      Here is the argument schema for this tool:
      {\"shell_command\" : <shell_script>}
    `
  }

  setAiProvider(client: AIProvider) {}

  async execute(input: Record<string, unknown>): Promise<string> {
    let result = await runShell(input.shell_command as string);
    return JSON.stringify(result)
  }

    shouldSummariseResult(): boolean {
    return false;
  }
}


// ─────────────────────────────────────────
// FILE EDIT TOOL
// ─────────────────────────────────────────
export class FileEdit implements AgentTool {
  name: string;
  toolDescription: string;

  constructor() {
    this.name = "FileEdit";
    this.toolDescription = `
      Use this tool to create or overwrite a file with new content, or to apply a targeted
      search-and-replace patch to an existing file.

      Prefer this tool over ShellExecute for any file write/edit operations — it is safer,
      atomic, and handles encoding correctly.

      Two modes:

      1. WRITE mode — create or fully overwrite a file:
         {
           "mode": "write",
           "path": "<absolute or workspace-relative file path>",
           "content": "<full file content as a string>"
         }

      2. PATCH mode — replace an exact string inside an existing file:
         {
           "mode": "patch",
           "path": "<absolute or workspace-relative file path>",
           "old_content": "<exact substring to find>",
           "new_content": "<replacement string>"
         }
         The patch will fail if old_content is not found exactly once in the file,
         so always use enough surrounding context to make it unique.
      
      Here is the extension context info that might be useful for you to construct shell commands:
      ${JSON.stringify(getExtensionContextInfo(), null, 2)}
    `;
  }

  setAiProvider(client: AIProvider) {}

  async execute(input: Record<string, unknown>): Promise<string> {
    const mode = input.mode as string;
    const rawPath = input.path as string;

    if (!mode || !rawPath) {
      return JSON.stringify({ success: false, error: "Missing required fields: mode, path" });
    }

    // Resolve relative paths against workspace root
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const filePath = path.isAbsolute(rawPath) ? rawPath : path.join(workspaceRoot, rawPath);

    try {
      if (mode === "write") {
        const content = input.content as string;
        if (content === undefined) {
          return JSON.stringify({ success: false, error: "Missing field: content" });
        }

        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");

        return JSON.stringify({ success: true, path: filePath, mode: "write" });
      }

      if (mode === "patch") {
        const oldContent = input.old_content as string;
        const newContent = input.new_content as string;

        if (oldContent === undefined || newContent === undefined) {
          return JSON.stringify({ success: false, error: "Missing fields: old_content, new_content" });
        }

        const existing = await fs.readFile(filePath, "utf8");

        const occurrences = existing.split(oldContent).length - 1;
        if (occurrences === 0) {
          return JSON.stringify({ success: false, error: "old_content not found in file" });
        }
        if (occurrences > 1) {
          return JSON.stringify({
            success: false,
            error: `old_content found ${occurrences} times — add more surrounding context to make it unique`,
          });
        }

        const patched = existing.replace(oldContent, newContent);
        await fs.writeFile(filePath, patched, "utf8");

        return JSON.stringify({ success: true, path: filePath, mode: "patch" });
      }

      return JSON.stringify({ success: false, error: `Unknown mode: ${mode}. Use "write" or "patch"` });
    } catch (err: any) {
      return JSON.stringify({ success: false, error: err?.message ?? String(err) });
    }
  }

  shouldSummariseResult(): boolean {
    return false;
  }
}