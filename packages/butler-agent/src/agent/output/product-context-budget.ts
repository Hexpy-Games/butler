import { estimateTokensForModel } from "../../integrations/providers/model-catalog.ts";

const TOKENIZER_CHUNK_CHARACTERS = 256;

/** Conservative estimate: independent chunks avoid quadratic BPE work on long unbroken input. */
export function estimateProductContextTokens(text: string, model: string): number {
  let total = 0;
  for (let offset = 0; offset < text.length; offset += TOKENIZER_CHUNK_CHARACTERS) {
    total += estimateTokensForModel(text.slice(offset, offset + TOKENIZER_CHUNK_CHARACTERS), model).tokens;
  }
  return total;
}
