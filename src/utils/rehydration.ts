export const rehydrateResponse = (
  llmText: string,
  tokenDictionary: Record<string, string>
): string => {
  if (!llmText || !tokenDictionary || Object.keys(tokenDictionary).length === 0) {
    return llmText;
  }

  let rehydratedText = llmText;

  // Sort by token length so longer placeholders are replaced first.
  // This prevents edge cases where one token name is a prefix of another.
  const replacements = Object.entries(tokenDictionary).sort(
    ([leftToken], [rightToken]) => rightToken.length - leftToken.length
  );

  for (const [token, originalValue] of replacements) {
    rehydratedText = rehydratedText.replaceAll(token, originalValue);
  }

  return rehydratedText;
};
