import { HybridStore } from "../core/search/hybridStore";
import { extractCodeSnippetFromFile } from "../core/parser/utils";
import { AgentTool } from "./types";


export class RepoSearch implements AgentTool {
  private hybridStore: HybridStore
  name: string = 'RepoSearchTool'
  toolDescription: string = `This tools allows the agent to search the repo for a query string and returns matching source code entities. Arguments {"query" : <string_to_search>}`
  constructor(hybridStore: HybridStore) {
    this.hybridStore = hybridStore;
  }
  async execute(input: string): Promise<string> {
    let jsonInput = JSON.parse(input);
    return JSON.stringify(this.hybridStore.search(jsonInput["query"]));
  }

}

export class GetEntityCode implements AgentTool {
  private hybridStore: HybridStore;
  name: string = `GetEntityCode`;
  toolDescription: string = `Reads source for the entity_id requested. Arguments {"entity_id" : <entity id from RepoSearchTool whose code is required by agent>}`;
  constructor(hybridStore: HybridStore) {
    this.hybridStore = hybridStore;
  }
  async execute(input: string): Promise<string> {
    let jsonInput = JSON.parse(input);
    let entityId = jsonInput["entity_id"];
    let entity = await this.hybridStore.getEntity(entityId);
    if (entity.code?.endsWith("..")) {
      return extractCodeSnippetFromFile(
        entity.filePath,
        entity.startIndex!,
        entity.endIndex!,
        false
      )
    }
    return entity.code!;
  }

}