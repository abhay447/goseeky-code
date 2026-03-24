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
    this.toolDescription= "Use this tool to discover logic, patterns, or business rules within the source code. It is designed to find 'how' things are implemented or where specific features live. Avoid using this for repository-wide metadata or structural audits. Argument Schema: {\"query\" : <string_to_search>}"
  }

  setAiProvider(client: AIProvider) {}
  async execute(input: Record<string, unknown>): Promise<string> {
    let result =  await this.hybridStore.search(input.query as string);
    // console.log("Search results" + result);
    return JSON.stringify(result);
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