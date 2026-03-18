import { PythonExtractor } from "./languages/python/extractor";
import { TypeScriptExtractor } from "./languages/typescript/extractor";
import { LanguageExtractor } from "./types";

const registry = new Map<string, LanguageExtractor>();

export function registerLanguage(extractor: LanguageExtractor) {
  extractor.extensions.forEach((ext) => {
    registry.set(ext, extractor);
  });
}

export function getExtractorByExt(ext: string): LanguageExtractor | undefined {
  return registry.get(ext);
}

export function getExtractorForFile(filePath: string): LanguageExtractor | undefined {
  const ext = getFileExtension(filePath);
  return registry.get(ext);
}

function getFileExtension(filePath: string): string {
  const idx = filePath.lastIndexOf(".");
  if (idx === -1) return "";
  return filePath.slice(idx);
}

registerLanguage(new TypeScriptExtractor())
registerLanguage(new PythonExtractor())