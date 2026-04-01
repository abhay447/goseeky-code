import fs from "fs";
import { HybridStore } from "../search/hybridStore";

export function extractCodeSnippet(
  fullCode: string,
  startIndex: number,
  endIndex: number,
  shouldTruncate: boolean = true
) {
  const code = fullCode.slice(startIndex, endIndex);
  if(shouldTruncate){
    return truncate(code);
  } else {
    return code;
  }
}

export async function extractEntityCode(entityId: string, hybridStore: HybridStore){
  let entity = await hybridStore.getEntity(entityId);
    if (entity.code?.endsWith("..")) {
      return extractCodeSnippetFromFile(
        entity.filePath,
        entity.codeByteStartIndex!,
        entity.codeByteEndIndex!,
        false
      )
    }
    return entity.code!;
}

 function extractCodeSnippetFromFile(
  filePath: string,
  startIndex: number,
  endIndex: number,
  shouldTruncate: boolean = true
) {
  const fullCode = fs.readFileSync(filePath, "utf-8");
  return extractCodeSnippet(fullCode,startIndex,endIndex,shouldTruncate);

}

function truncate(code: string, maxChars = 1000) {
  return code.length > maxChars
    ? code.slice(0, maxChars) + "..."
    : code;
}

