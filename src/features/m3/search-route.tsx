import { ArrowLeft, Loader2, MessageSquareText, Search } from "lucide-react";
import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Virtuoso } from "react-virtuoso";

import { EmptyState, PageShell, Panel, PanelHeader } from "../../components/layout/page-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { createDbWorkerClient } from "../../lib/worker-client";
import type {
  SearchMessageResult,
  SearchMessagesFilters,
  SearchMessagesResponse,
} from "../../lib/worker-types";
import {
  conversationTitle,
  formatDateTime,
  formatError,
  formatWorkerResultError,
  InlineNotice,
  mergeBy,
  participantLabel,
  RecentRouteGate,
  useConversationPages,
  useRecentRouteState,
} from "./m3-shared";

type ResultsState =
  | { kind: "idle"; response?: SearchMessagesResponse }
  | { kind: "loading"; response?: SearchMessagesResponse }
  | { kind: "error"; message: string; response?: SearchMessagesResponse }
  | { kind: "ready"; response: SearchMessagesResponse };

interface ActiveSearch {
  filters: SearchMessagesFilters;
  text: string;
  /**
   * Monotonic per-submit token. Load-more staleness is keyed on this instead
   * of a text+filters identity so a resubmitted identical query cannot have a
   * stale load-more reset its loading flag or surface stale errors.
   */
  token: number;
}

const searchPageSize = 100;
const conversationFilterPageSize = 100;
type DbWorkerClient = ReturnType<typeof createDbWorkerClient>;

export function SearchRoute() {
  const { id } = useParams<{ id: string }>();
  const backupId = id ?? "";
  const routeState = useRecentRouteState(backupId);

  return (
    <RecentRouteGate
      backupId={backupId}
      description="Search messages in the local derived database."
      routeState={routeState}
      title="Search"
    >
      {(record) => (
        <SearchWorkspace
          backupId={record.id}
          key={record.id}
          title={record.friendlyName}
        />
      )}
    </RecentRouteGate>
  );
}

function SearchWorkspace({ backupId, title }: { backupId: string; title: string }) {
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [conversationId, setConversationId] = useState(
    searchParams.get("conversation") ?? "",
  );
  const [participantQuery, setParticipantQuery] = useState("");
  const [hasAttachment, setHasAttachment] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [resultsState, setResultsState] = useState<ResultsState>({
    kind: "idle",
  });
  const [activeSearch, setActiveSearch] = useState<ActiveSearch | undefined>();
  const [loadingMoreResults, setLoadingMoreResults] = useState(false);
  const [moreResultsError, setMoreResultsError] = useState<string | undefined>();
  const activeSearchRef = useRef<ActiveSearch | undefined>(undefined);
  // The search whose results are currently displayed in resultsState.response.
  // Used to restore pagination when a newer search fails and the previous
  // results stay visible.
  const displayedSearchRef = useRef<ActiveSearch | undefined>(undefined);
  const dbClientRef = useRef<DbWorkerClient | undefined>(undefined);
  const searchRequestIdRef = useRef(0);
  const getDbClient = useCallback(() => {
    dbClientRef.current ??= createDbWorkerClient();

    return dbClientRef.current;
  }, []);
  const {
    conversationsState: conversationState,
    loadMoreConversations: loadMoreConversationFilters,
  } = useConversationPages({
    backupId,
    getDbClient,
    pageSize: conversationFilterPageSize,
  });

  useEffect(() => {
    activeSearchRef.current = activeSearch;
  }, [activeSearch]);

  useEffect(
    () => () => {
      dbClientRef.current?.release();
      dbClientRef.current = undefined;
    },
    [backupId],
  );

  const previousResponse =
    resultsState.kind === "loading" || resultsState.kind === "error"
      ? resultsState.response
      : resultsState.kind === "ready"
        ? resultsState.response
        : undefined;

  const submitSearch = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requestId = searchRequestIdRef.current + 1;

    searchRequestIdRef.current = requestId;
    setLoadingMoreResults(false);
    activeSearchRef.current = undefined;
    setActiveSearch(undefined);

    if (query.trim().length === 0) {
      setMoreResultsError(undefined);
      setResultsState({ kind: "idle", response: previousResponse });
      return;
    }

    setResultsState({ kind: "loading", response: previousResponse });
    setMoreResultsError(undefined);

    const client = getDbClient();
    const filters = buildFilters({
      conversationId,
      fromDate,
      hasAttachment,
      participantQuery,
      toDate,
    });
    const text = query.trim();
    const search: ActiveSearch = { filters, text, token: requestId };
    // When this search fails while the previous results stay visible,
    // restore the search that produced those results so they can still
    // paginate.
    const restoreDisplayedSearch = () => {
      const displayedSearch = displayedSearchRef.current;

      activeSearchRef.current = displayedSearch;
      setActiveSearch(displayedSearch);
    };

    try {
      const result = await client.api.searchMessages({
        backupId,
        filters,
        limit: searchPageSize,
        text,
      });

      if (searchRequestIdRef.current !== requestId) {
        return;
      }

      if (!result.ok) {
        restoreDisplayedSearch();
        setResultsState({
          kind: "error",
          message: formatWorkerResultError(result.error),
          response: previousResponse,
        });
        return;
      }

      displayedSearchRef.current = search;
      activeSearchRef.current = search;
      setActiveSearch(search);
      setResultsState({ kind: "ready", response: result.value });
    } catch (cause) {
      if (searchRequestIdRef.current !== requestId) {
        return;
      }

      restoreDisplayedSearch();
      setResultsState({
        kind: "error",
        message: formatError(cause),
        response: previousResponse,
      });
    }
  };
  const loadMoreResults = async () => {
    const response = resultsState.response;
    const requestedSearch = activeSearch;

    if (
      requestedSearch === undefined ||
      response === undefined ||
      response.results.length >= response.total ||
      loadingMoreResults
    ) {
      return;
    }

    setLoadingMoreResults(true);
    setMoreResultsError(undefined);

    const client = getDbClient();

    try {
      const result = await client.api.searchMessages({
        backupId,
        filters: requestedSearch.filters,
        limit: searchPageSize,
        offset: response.results.length,
        text: requestedSearch.text,
      });

      if (activeSearchRef.current?.token !== requestedSearch.token) {
        return;
      }

      if (!result.ok) {
        setMoreResultsError(formatWorkerResultError(result.error));
        return;
      }

      setResultsState((current) => {
        const currentResponse = current.response;

        if (
          currentResponse === undefined ||
          activeSearchRef.current?.token !== requestedSearch.token
        ) {
          return current;
        }

        return {
          kind: "ready",
          response: {
            ...result.value,
            offset: 0,
            results: mergeBy(
              currentResponse.results,
              result.value.results,
              (item) => item.message.id,
            ),
            total: result.value.total,
          },
        };
      });
    } catch (cause) {
      if (activeSearchRef.current?.token === requestedSearch.token) {
        setMoreResultsError(formatError(cause));
      }
    } finally {
      if (activeSearchRef.current?.token === requestedSearch.token) {
        setLoadingMoreResults(false);
      }
    }
  };

  const response = resultsState.response;
  const hasSelectedConversationOption =
    conversationId.trim().length === 0 ||
    (conversationState.kind === "ready" &&
      conversationState.conversations.some(
        (conversation) => conversation.id === conversationId,
      ));

  return (
    <PageShell
      actions={
        <>
          <Button asChild size="sm" variant="ghost">
            <Link to={`/backup/${encodeURIComponent(backupId)}`}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              Overview
            </Link>
          </Button>
          <Badge variant="success">Ingested</Badge>
        </>
      }
      description="Search message text with conversation, participant, attachment, and date filters."
      eyebrow="Search"
      maxWidth="full"
      title={title}
    >
      <Panel>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            void submitSearch(event);
          }}
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <label className="min-w-0 flex-1">
              <span className="text-caption text-text-secondary">Search messages</span>
              <input
                className="mt-1 h-[var(--control-height-lg)] w-full rounded-md border border-border-strong bg-surface-sunken px-3 text-body text-text placeholder:text-text-tertiary"
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                placeholder="Enter message text"
                type="search"
                value={query}
              />
            </label>
            <Button
              disabled={resultsState.kind === "loading"}
              size="lg"
              type="submit"
              variant="primary"
            >
              <Search aria-hidden="true" className="size-4" />
              Search
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <label>
              <span className="text-caption text-text-secondary">Conversation</span>
              <select
                className="mt-1 h-[var(--control-height-md)] w-full rounded-md border border-border-strong bg-surface-sunken px-2 text-body text-text"
                onChange={(event) => {
                  setConversationId(event.target.value);
                }}
                value={conversationId}
              >
                <option value="">All conversations</option>
                {!hasSelectedConversationOption ? (
                  <option value={conversationId}>Selected conversation</option>
                ) : null}
                {conversationState.kind === "ready"
                  ? conversationState.conversations.map((conversation) => (
                      <option key={conversation.id} value={conversation.id}>
                        {conversationTitle(conversation)}
                      </option>
                    ))
                  : null}
              </select>
            </label>

            <label>
              <span className="text-caption text-text-secondary">Participant</span>
              <input
                className="mt-1 h-[var(--control-height-md)] w-full rounded-md border border-border-strong bg-surface-sunken px-2 text-body text-text placeholder:text-text-tertiary"
                onChange={(event) => {
                  setParticipantQuery(event.target.value);
                }}
                placeholder="Name or handle"
                type="text"
                value={participantQuery}
              />
            </label>

            <label>
              <span className="text-caption text-text-secondary">From</span>
              <input
                className="mt-1 h-[var(--control-height-md)] w-full rounded-md border border-border-strong bg-surface-sunken px-2 text-body text-text"
                onChange={(event) => {
                  setFromDate(event.target.value);
                }}
                type="date"
                value={fromDate}
              />
            </label>

            <label>
              <span className="text-caption text-text-secondary">To</span>
              <input
                className="mt-1 h-[var(--control-height-md)] w-full rounded-md border border-border-strong bg-surface-sunken px-2 text-body text-text"
                onChange={(event) => {
                  setToDate(event.target.value);
                }}
                type="date"
                value={toDate}
              />
            </label>

            <label className="flex items-end gap-2 pb-1 text-body text-text">
              <input
                checked={hasAttachment}
                className="rounded border-border-strong bg-surface-sunken text-accent"
                onChange={(event) => {
                  setHasAttachment(event.target.checked);
                }}
                type="checkbox"
              />
              Has attachment
            </label>
          </div>
        </form>
        {conversationState.kind === "error" ? (
          <div className="mt-4">
            <InlineNotice kind="danger">{conversationState.message}</InlineNotice>
          </div>
        ) : null}
        {conversationState.kind === "ready" &&
        conversationState.moreError !== undefined ? (
          <div className="mt-4">
            <InlineNotice kind="danger">{conversationState.moreError}</InlineNotice>
          </div>
        ) : null}
        {conversationState.kind === "ready" &&
        conversationState.conversations.length < conversationState.total ? (
          <div className="mt-4">
            <Button
              disabled={conversationState.loadingMore}
              onClick={() => {
                void loadMoreConversationFilters();
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              {conversationState.loadingMore
                ? "Loading conversations..."
                : "Load more conversations"}
            </Button>
          </div>
        ) : null}
      </Panel>

      <Panel className="min-h-[var(--layout-workspace-min)]">
        <PanelHeader
          badge={
            <Badge variant={resultsState.kind === "loading" ? "info" : "neutral"}>
              {response === undefined ? "0 results" : `${response.total.toLocaleString()} results`}
            </Badge>
          }
          description="Open a result in its conversation to inspect adjacent messages and provenance."
          title="Results"
        />
        <SearchResults
          backupId={backupId}
          loadingMoreResults={loadingMoreResults}
          moreResultsError={moreResultsError}
          resultsState={resultsState}
          onLoadMoreResults={() => {
            void loadMoreResults();
          }}
        />
      </Panel>
    </PageShell>
  );
}

function SearchResults({
  backupId,
  loadingMoreResults,
  moreResultsError,
  onLoadMoreResults,
  resultsState,
}: {
  backupId: string;
  loadingMoreResults: boolean;
  moreResultsError: string | undefined;
  onLoadMoreResults: () => void;
  resultsState: ResultsState;
}) {
  const response = resultsState.response;

  if (resultsState.kind === "idle" && response === undefined) {
    return (
      <div className="mt-6">
        <EmptyState icon={<Search aria-hidden="true" className="size-6" />}>
          Enter a query to search extracted message text.
        </EmptyState>
      </div>
    );
  }

  if (resultsState.kind === "loading" && response === undefined) {
    return (
      <div className="mt-6">
        <EmptyState icon={<Loader2 aria-hidden="true" className="size-6" />}>
          Searching messages.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="mt-4">
      {resultsState.kind === "loading" ? (
        <InlineNotice>Searching messages. Previous results remain visible.</InlineNotice>
      ) : null}
      {resultsState.kind === "error" ? (
        <div className="mb-4">
          <InlineNotice kind="danger">{resultsState.message}</InlineNotice>
        </div>
      ) : null}
      {moreResultsError === undefined ? null : (
        <div className="mb-4">
          <InlineNotice kind="danger">{moreResultsError}</InlineNotice>
        </div>
      )}
      {response?.results.length === 0 ? (
        <EmptyState icon={<MessageSquareText aria-hidden="true" className="size-6" />}>
          No messages matched this search.
        </EmptyState>
      ) : null}
      {response !== undefined && response.results.length > 0 ? (
        <div
          className="h-[calc(var(--layout-workspace-min)_-_var(--layout-pane-header))]"
          data-testid="m3-search-results"
        >
          <Virtuoso
            className="h-full"
            data={response.results}
            itemContent={(_, result) => (
              <ResultRow backupId={backupId} result={result} />
            )}
          />
        </div>
      ) : null}
      {(resultsState.kind === "ready" || resultsState.kind === "error") &&
      response !== undefined &&
      response.results.length < response.total ? (
        <div className="mt-4">
          <Button
            disabled={loadingMoreResults}
            onClick={onLoadMoreResults}
            type="button"
            variant="secondary"
          >
            {loadingMoreResults ? "Loading..." : "Load more results"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ResultRow({
  backupId,
  result,
}: {
  backupId: string;
  result: SearchMessageResult;
}) {
  const title = conversationTitle(result.conversation);
  const sender =
    result.message.sender === undefined
      ? result.message.isFromMe
        ? "Me"
        : "Unknown sender"
      : participantLabel(result.message.sender);

  return (
    <article
      className="border-b border-border px-3 py-4"
      data-testid={`search-result-${String(result.message.sourceRowId)}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-heading text-text">{title}</h3>
          <p className="mt-1 text-caption text-text-secondary">
            {sender} / {formatDateTime(result.message.sentAtUtc)}
          </p>
        </div>
        <Button asChild size="sm" variant="secondary">
          <Link
            to={`/backup/${encodeURIComponent(backupId)}/messages?conversation=${encodeURIComponent(result.message.conversationId)}&message=${encodeURIComponent(result.message.id)}`}
          >
            Open in messages
          </Link>
        </Button>
      </div>
      <p className="mt-3 max-w-[var(--layout-content-text)] text-body text-text">
        {result.snippets.map((segment, index) => (
          <span
            className={cn(
              segment.highlighted &&
                "bg-accent-subtle text-accent-text underline decoration-accent-text",
            )}
            key={`${segment.text}-${String(index)}`}
          >
            {segment.text}
          </span>
        ))}
      </p>
      {result.message.attachments.length > 0 ? (
        <p className="mt-2 text-caption text-text-secondary">
          {result.message.attachments.length.toLocaleString()} attachment
          {result.message.attachments.length === 1 ? "" : "s"}
        </p>
      ) : null}
    </article>
  );
}

function buildFilters(input: {
  conversationId: string;
  fromDate: string;
  hasAttachment: boolean;
  participantQuery: string;
  toDate: string;
}): SearchMessagesFilters {
  return {
    ...(input.conversationId.trim().length === 0
      ? {}
      : { conversationId: input.conversationId }),
    ...(input.participantQuery.trim().length === 0
      ? {}
      : { participantQuery: input.participantQuery.trim() }),
    ...(input.fromDate.trim().length === 0
      ? {}
      : { fromUtc: `${input.fromDate}T00:00:00.000Z` }),
    ...(input.toDate.trim().length === 0
      ? {}
      : { toUtcExclusive: nextUtcDate(input.toDate) }),
    ...(input.hasAttachment ? { hasAttachment: true } : {}),
  };
}

function nextUtcDate(dateInput: string): string {
  const date = new Date(`${dateInput}T00:00:00.000Z`);

  date.setUTCDate(date.getUTCDate() + 1);

  return date.toISOString();
}
