import * as vscode from "vscode";
import * as os from 'os';
import * as process from 'process';
import { runShell } from "../utils/shellUtils";
import * as fs from 'fs';
import { HybridStore } from "../core/search/hybridStore";
import { Entity } from "../core/parser/types";
import { extractCodeSnippet } from "../core/parser/utils";

async function repoSearch(searchQuery: string, hybridStore: HybridStore) {
  return hybridStore.search(searchQuery)
}

async function fetchEntityCode(entity: Entity) {
  if(entity.code?.endsWith("..")){
    return extractCodeSnippet(
        entity.filePath,
        entity.startIndex!,
        entity.endIndex!,
        false
        
    )
  }
  return entity.code;
}