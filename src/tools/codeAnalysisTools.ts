import { HybridStore } from "../core/search/hybridStore";
import { extractEntityCode } from "../core/parser/utils";
import { AgentTool } from "./types";
import { AIProvider } from "../providers";

export class RepoSearch implements AgentTool {
  private hybridStore: HybridStore
  name: string
  toolDescription: string
  constructor(hybridStore: HybridStore) {
    this.hybridStore = hybridStore;
    this.name = 'RepoSearchTool'
    this.toolDescription= `
      Use this tool to discover enttites obtained by parsing source code and their relationships. 
      This tool doesn't expose and see source code, for analysing source code you should use : AnalyseEntity .
      DO NOT repeat calls to this tool with same arguments, if something got missed during code parsing and does not appear in search results then you should fallback to ShellExecute tool. 
      Argument Schema: {\"query\" : <string_to_search>}`
  }

  setAiProvider(client: AIProvider) {}
  async execute(input: Record<string, unknown>): Promise<string> {
    let result =  await this.hybridStore.search(input.query as string);
    // console.log("Search results" + result);
    return JSON.stringify(result);
  }
  shouldSummariseResult(): boolean {
    return false;
  }
}

export class GetEntityCode implements AgentTool {
  private hybridStore: HybridStore;
  name: string
  toolDescription: string
  constructor(hybridStore: HybridStore) {
    this.hybridStore = hybridStore;
    this.name = `GetEntityCode`;
    this.toolDescription = "Reads source for the entity_id requested. Argument Schema: {\"entity_id\" : <entity id from RepoSearchTool whose code is required>}";

  }
  setAiProvider(client: AIProvider) {}
  async execute(input: Record<string, unknown>): Promise<string> {
    return await extractEntityCode(input.entity_id as string, this.hybridStore);
  }

  shouldSummariseResult(): boolean {
    return true;
  }

}

export class AnalyseEntityCode implements AgentTool {
  private hybridStore: HybridStore;
  name: string
  toolDescription: string
  client: AIProvider | null = null;

  constructor(hybridStore: HybridStore) {
    this.hybridStore = hybridStore;
    this.name = `AnalyseEntity`;
    this.toolDescription = "Allows Q&A and natural language analysis of entity by analysing entity code. Argument Schema: {\"entity_id\" : <entity id from RepoSearchTool>, \"analysis_prompt\" : <user supplied prompt on how they want to analyse the code>}";
  }

  shouldSummariseResult(): boolean {
    return false;
  }
  isIntelligentTool(): boolean {
    return true;
  }

  setAiProvider(client: AIProvider) {
    this.client = client;
  }

  buildAnalysisPrompt(code: string, userPrompt: string) {
    return ` Given the code snippet below:
      '''
        ${code}
      ''' 

      Generate an appropriate response for user based on the below analysis prompt:
      '''
        ${userPrompt}
      '''
    `
  }
  async execute(input: Record<string, unknown>): Promise<string> {
    let code = await extractEntityCode(input.entity_id as string, this.hybridStore);
    let analysisSystemPrompt = this.buildAnalysisPrompt(code, input.analysis_prompt as string );
    return await this.client?.chat(
      [
        {
          "role" : "system",
          "content": analysisSystemPrompt
        }
      ]
    )!;
    
  }

}