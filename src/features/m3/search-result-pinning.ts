export function includePinnedSearchResult<
  TResult extends { message: { id: string } },
>(results: TResult[], pinnedResult: TResult | undefined): TResult[] {
  if (
    pinnedResult === undefined ||
    results.some((result) => result.message.id === pinnedResult.message.id)
  ) {
    return results;
  }

  return [...results, pinnedResult];
}

export function selectScopedCachedSearchResult<
  TResult extends {
    conversation: { id: string };
    message: { conversationId: string; id: string };
  },
>(
  resultsByMessageId: ReadonlyMap<string, TResult>,
  selectedMessageId: string | undefined,
  selectedConversationId: string | undefined,
): TResult | undefined {
  if (selectedMessageId === undefined || selectedConversationId === undefined) {
    return undefined;
  }

  const cachedResult = resultsByMessageId.get(selectedMessageId);

  return cachedResult?.message.conversationId === selectedConversationId &&
    cachedResult.conversation.id === selectedConversationId
    ? cachedResult
    : undefined;
}
