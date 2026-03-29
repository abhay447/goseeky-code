import { AgentTool } from "./types";
import { runShell } from "../utils/shellUtils";
import { AIProvider } from "../providers";
import * as vscode from "vscode";
import * as os from "os";

function getExtensionContextInfo() {
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