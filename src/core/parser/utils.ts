import fs from "fs";

export function extractCodeSnippetFromFile(
  filePath: string,
  startIndex: number,
  endIndex: number,
  shouldTruncate: boolean = true
) {
  const fullCode = fs.readFileSync(filePath, "utf-8");
  return extractCodeSnippet(fullCode,startIndex,endIndex,shouldTruncate);

}

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

function truncate(code: string, maxChars = 1000) {
  return code.length > maxChars
    ? code.slice(0, maxChars) + "..."
    : code;
}

