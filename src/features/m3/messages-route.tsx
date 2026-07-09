import {
  ArrowLeft,
  Download,
  FileWarning,
  Image,
  Loader2,
  MessageSquareText,
  Video,
  X,
} from "lucide-react";
import { transfer } from "comlink";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Virtuoso } from "react-virtuoso";

import { EmptyState, PageShell } from "../../components/layout/page-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import {
  ensureRecentBackupDirectoryPermission,
  type RecentBackupRecord,
} from "../../lib/recents";
import {
  createBackupWorkerClient,
  createDbWorkerClient,
  createMediaWorkerClient,
} from "../../lib/worker-client";
import type {
  AttachmentThumbnailOkResponse,
  DbAttachmentSummary,
  DbConversationSummary,
  DbMessageRecord,
  MessageDetailsResponse,
  MessageTimelinePageResponse,
} from "../../lib/worker-types";
import {
  defaultThumbnailMaxPixelSize,
  extractMaxReadBytes,
  previewImageMaxBytes,
  previewVideoMaxBytes,
} from "../../workers/shared/media-limits";
import {
  conversationTitle,
  type ConversationsState,
  DataRow,
  formatBytes,
  formatDateTime,
  formatDay,
  formatError,
  formatWorkerResultError,
  InlineNotice,
  isInlinePreviewMediaKind,
  isThumbnailPreviewMediaKind,
  mergeById,
  participantLabel,
  RecentRouteGate,
  useConversationPages,
  useRecentRouteState,
} from "./m3-shared";

const conversationPageSize = 100;
const timelinePageSize = 100;
const timelineInitialFirstItemIndex = 100_000;
const previewConcurrency = 2;

type TimelineState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      loadingAfter: boolean;
      loadingBefore: boolean;
      firstItemIndex: number;
      moreErrorAfter?: string;
      moreErrorBefore?: string;
      page: MessageTimelinePageResponse;
    };

type BackupWorkerClient = ReturnType<typeof createBackupWorkerClient>;
type DbWorkerClient = ReturnType<typeof createDbWorkerClient>;
type MediaWorkerClient = ReturnType<typeof createMediaWorkerClient>;
type RunPreviewTask = <TResult>(task: () => Promise<TResult>) => Promise<TResult>;
interface PreviewTaskRunner {
  <TResult>(task: () => Promise<TResult>): Promise<TResult>;
  cancel(): void;
}

type DetailState =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; details: MessageDetailsResponse };

type TimelineRow =
  | { kind: "day"; id: string; label: string }
  | {
      kind: "message";
      id: string;
      message: DbMessageRecord;
      runStart: boolean;
      runEnd: boolean;
    };

type AttachmentPreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "needs-permission" }
  | {
      kind: "image";
      caption?: string;
      height?: number;
      url: string;
      width?: number;
    }
  | {
      kind: "video";
      url: string;
    }
  | { kind: "unsupported"; message: string }
  | { kind: "error"; message: string };

export function MessagesRoute() {
  const { id } = useParams<{ id: string }>();
  const backupId = id ?? "";
  const routeState = useRecentRouteState(backupId);

  return (
    <RecentRouteGate
      backupId={backupId}
      description="Browse message conversations from the local derived database."
      routeState={routeState}
      title="Messages"
    >
      {(record) => <MessagesWorkspace key={record.id} record={record} />}
    </RecentRouteGate>
  );
}

function MessagesWorkspace({ record }: { record: RecentBackupRecord }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const selectedConversationId = searchParams.get("conversation") ?? undefined;
  const selectedMessageId = searchParams.get("message") ?? undefined;
  const [timelineState, setTimelineState] = useState<TimelineState>({
    kind: "idle",
  });
  const [detailState, setDetailState] = useState<DetailState>({ kind: "empty" });
  const [detailOverlayActive, setDetailOverlayActive] = useState(false);
  const timelineStateRef = useRef<TimelineState>(timelineState);
  const dbClientRef = useRef<DbWorkerClient | undefined>(undefined);
  const backupClientRef = useRef<BackupWorkerClient | undefined>(undefined);
  const mediaClientRef = useRef<MediaWorkerClient | undefined>(undefined);
  const previewRunnerRef = useRef<PreviewTaskRunner | undefined>(undefined);
  const detailPaneRef = useRef<HTMLElement | null>(null);
  const detailReturnFocusRef = useRef<HTMLElement | undefined>(undefined);
  const runPreviewTask = useCallback(
    <TResult,>(task: () => Promise<TResult>): Promise<TResult> => {
      // Created lazily (not in useMemo) so a StrictMode remount gets a fresh,
      // working limiter after the unmount cleanup cancelled the previous one.
      previewRunnerRef.current ??= createPreviewTaskRunner(previewConcurrency);

      return previewRunnerRef.current(task);
    },
    [],
  );
  const getDbClient = useCallback(() => {
    dbClientRef.current ??= createDbWorkerClient();

    return dbClientRef.current;
  }, []);
  const getBackupClient = useCallback(() => {
    backupClientRef.current ??= createBackupWorkerClient();

    return backupClientRef.current;
  }, []);
  const getMediaClient = useCallback(() => {
    mediaClientRef.current ??= createMediaWorkerClient();

    return mediaClientRef.current;
  }, []);
  const { conversationsState, loadMoreConversations } = useConversationPages({
    backupId: record.id,
    getDbClient,
    pageSize: conversationPageSize,
  });

  useEffect(() => {
    timelineStateRef.current = timelineState;
  }, [timelineState]);

  useEffect(
    () => () => {
      // Reject queued preview tasks so real unmount never leaves callers
      // pending; the next runPreviewTask call lazily creates a new runner.
      previewRunnerRef.current?.cancel();
      previewRunnerRef.current = undefined;
      dbClientRef.current?.release();
      dbClientRef.current = undefined;
      backupClientRef.current?.release();
      backupClientRef.current = undefined;
      mediaClientRef.current?.release();
      mediaClientRef.current = undefined;
    },
    [],
  );

  useEffect(() => {
    // Below the responsive floor (Design.md section 8; Tailwind lg ===
    // --layout-responsive-floor === 64rem) the detail pane overlays instead
    // of docking, so it needs dialog semantics and focus handling.
    const media = window.matchMedia("(min-width: 64rem)");
    const update = () => {
      setDetailOverlayActive(!media.matches);
    };

    update();
    media.addEventListener("change", update);

    return () => {
      media.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    if (conversationsState.kind !== "ready") {
      return;
    }

    const conversations = conversationsState.conversations;

    if (conversations.length === 0) {
      return;
    }

    if (selectedConversationId !== undefined) {
      return;
    }

    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);

        next.set("conversation", conversations[0]?.id ?? "");
        next.delete("message");

        return next;
      },
      { replace: true },
    );
  }, [conversationsState, selectedConversationId, setSearchParams]);

  useEffect(() => {
    if (selectedConversationId === undefined) {
      setTimelineState({ kind: "idle" });
      return;
    }

    const currentTimeline = timelineStateRef.current;

    // Keep the loaded pages when the conversation already matches and the
    // selected message (if any) is present — closing the detail panel
    // (clearing ?message) must not reset or refetch the timeline.
    if (
      currentTimeline.kind === "ready" &&
      currentTimeline.page.conversation.id === selectedConversationId &&
      (selectedMessageId === undefined ||
        currentTimeline.page.messages.some(
          (message) => message.id === selectedMessageId,
        ))
    ) {
      return;
    }

    const active = { current: true };
    const client = getDbClient();

    setTimelineState({ kind: "loading" });
    void (async () => {
      try {
        const result = await client.api.getMessageTimelinePage({
          backupId: record.id,
          conversationId: selectedConversationId,
          ...(selectedMessageId === undefined
            ? {}
            : { anchorMessageId: selectedMessageId }),
          limit: timelinePageSize,
        });

        if (!active.current) {
          return;
        }

        if (!result.ok) {
          setTimelineState({
            kind: "error",
            message: formatWorkerResultError(result.error),
          });
          return;
        }

        setTimelineState({
          kind: "ready",
          firstItemIndex: timelineInitialFirstItemIndex,
          loadingAfter: false,
          loadingBefore: false,
          page: result.value,
        });
      } catch (cause) {
        if (active.current) {
          setTimelineState({ kind: "error", message: formatError(cause) });
        }
      }
    })();

    return () => {
      active.current = false;
    };
  }, [getDbClient, record.id, selectedConversationId, selectedMessageId]);

  useEffect(() => {
    if (selectedMessageId === undefined) {
      setDetailState({ kind: "empty" });
      return;
    }

    const currentTimeline = timelineStateRef.current;

    if (currentTimeline.kind === "loading") {
      setDetailState({ kind: "loading" });
      return;
    }

    if (currentTimeline.kind === "ready") {
      const message = currentTimeline.page.messages.find(
        (candidate) => candidate.id === selectedMessageId,
      );

      if (message !== undefined) {
        setDetailState({
          kind: "ready",
          details: {
            conversation: currentTimeline.page.conversation,
            message,
          },
        });
        return;
      }
    }

    const active = { current: true };
    const client = getDbClient();

    setDetailState({ kind: "loading" });
    void (async () => {
      try {
        const result = await client.api.getMessageDetails({
          backupId: record.id,
          messageId: selectedMessageId,
        });

        if (!active.current) {
          return;
        }

        if (!result.ok) {
          setDetailState({
            kind: "error",
            message: formatWorkerResultError(result.error),
          });
          return;
        }

        if (result.value === undefined) {
          setDetailState({
            kind: "error",
            message: "The selected message is no longer in the derived database.",
          });
          return;
        }

        setDetailState({ kind: "ready", details: result.value });
      } catch (cause) {
        if (active.current) {
          setDetailState({ kind: "error", message: formatError(cause) });
        }
      }
    })();

    return () => {
      active.current = false;
    };
  }, [getDbClient, record.id, selectedMessageId, timelineState]);

  const detailOverlayOpen = detailOverlayActive && selectedMessageId !== undefined;

  useEffect(() => {
    if (!detailOverlayOpen) {
      return;
    }

    const previous = document.activeElement;

    detailReturnFocusRef.current =
      previous instanceof HTMLElement ? previous : undefined;
    detailPaneRef.current?.focus();

    return () => {
      detailReturnFocusRef.current?.focus();
      detailReturnFocusRef.current = undefined;
    };
  }, [detailOverlayOpen]);

  const selectedConversation =
    timelineState.kind === "ready" ? timelineState.page.conversation : undefined;
  const timelineRows = useMemo(
    () =>
      timelineState.kind === "ready"
        ? buildTimelineRows(timelineState.page.messages)
        : [],
    [timelineState],
  );

  const selectConversation = useCallback(
    (conversationId: string) => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);

        next.set("conversation", conversationId);
        next.delete("message");

        return next;
      });
    },
    [setSearchParams],
  );
  const selectMessage = useCallback(
    (messageId: string, conversationId: string) => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);

        next.set("conversation", conversationId);
        next.set("message", messageId);

        return next;
      });
    },
    [setSearchParams],
  );
  const closeDetail = useCallback(() => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);

      next.delete("message");

      return next;
    });
  }, [setSearchParams]);
  const loadTimelinePage = useCallback(
    async (direction: "after" | "before") => {
      let request:
        | {
            conversationId: string;
            offset: number;
          }
        | undefined;

      setTimelineState((current) => {
        if (current.kind !== "ready") {
          return current;
        }

        if (
          direction === "before" &&
          (current.loadingBefore || !current.page.hasMoreBefore)
        ) {
          return current;
        }

        if (
          direction === "after" &&
          (current.loadingAfter || !current.page.hasMoreAfter)
        ) {
          return current;
        }

        request = {
          conversationId: current.page.conversation.id,
          offset:
            direction === "before"
              ? Math.max(0, current.page.offset - timelinePageSize)
              : current.page.offset + current.page.messages.length,
        };

        return direction === "before"
          ? { ...current, loadingBefore: true, moreErrorBefore: undefined }
          : { ...current, loadingAfter: true, moreErrorAfter: undefined };
      });

      if (request === undefined) {
        return;
      }

      const client = getDbClient();

      try {
        // Load-more skips conversation hydration: the UI already has the
        // conversation from the initial getMessageTimelinePage response.
        const result = await client.api.getMessageTimelineMessagesPage({
          backupId: record.id,
          conversationId: request.conversationId,
          limit: timelinePageSize,
          offset: request.offset,
        });

        setTimelineState((current) => {
          if (
            current.kind !== "ready" ||
            current.page.conversation.id !== request?.conversationId
          ) {
            return current;
          }

          if (!result.ok) {
            const message = formatWorkerResultError(result.error);

            return direction === "before"
              ? { ...current, loadingBefore: false, moreErrorBefore: message }
              : { ...current, loadingAfter: false, moreErrorAfter: message };
          }

          const mergedMessages =
            direction === "before"
              ? mergeById(result.value.messages, current.page.messages)
              : mergeById(current.page.messages, result.value.messages);
          const firstItemIndex =
            direction === "before"
              ? current.firstItemIndex -
                Math.max(
                  0,
                  buildTimelineRows(mergedMessages).length -
                    buildTimelineRows(current.page.messages).length,
                )
              : current.firstItemIndex;

          return {
            ...current,
            firstItemIndex,
            ...(direction === "before"
              ? { loadingBefore: false }
              : { loadingAfter: false }),
            page: {
              ...current.page,
              hasMoreAfter:
                direction === "after"
                  ? result.value.hasMoreAfter
                  : current.page.hasMoreAfter,
              hasMoreBefore:
                direction === "before"
                  ? result.value.hasMoreBefore
                  : current.page.hasMoreBefore,
              messages: mergedMessages,
              offset:
                direction === "before"
                  ? result.value.offset
                  : current.page.offset,
              total: result.value.total,
            },
          };
        });
      } catch (cause) {
        setTimelineState((current) => {
          if (current.kind !== "ready") {
            return current;
          }

          const message = formatError(cause);

          return direction === "before"
            ? { ...current, loadingBefore: false, moreErrorBefore: message }
            : { ...current, loadingAfter: false, moreErrorAfter: message };
        });
      }
    },
    [getDbClient, record.id],
  );

  return (
    <PageShell
      actions={
        <>
          <Button asChild size="sm" variant="ghost">
            <Link to={`/backup/${encodeURIComponent(record.id)}`}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              Overview
            </Link>
          </Button>
          <Badge variant="success">Ingested</Badge>
        </>
      }
      description="Browse conversations, inspect message metadata, and preview source attachments without modifying the backup."
      eyebrow="Messages"
      maxWidth="full"
      title={record.friendlyName}
    >
      <div className="relative grid min-h-[var(--layout-workspace-min)] overflow-hidden rounded-lg border border-border bg-surface shadow-1 [grid-template-columns:minmax(var(--pane-threads),35%)_minmax(0,1fr)] lg:h-[calc(100vh_-_var(--layout-top-bar)_-_var(--space-64)_-_var(--space-64)_-_var(--space-48))] lg:[grid-template-columns:var(--pane-threads)_minmax(var(--pane-timeline-min),1fr)_var(--pane-detail)]">
        <MessagesPane title="Threads">
          <ConversationPane
            conversationsState={conversationsState}
            selectedConversationId={selectedConversationId}
            onLoadMoreConversations={() => {
              void loadMoreConversations();
            }}
            onSelectConversation={selectConversation}
          />
        </MessagesPane>

        <MessagesPane
          className="border-l border-border lg:border-r"
          title={selectedConversation === undefined ? "Timeline" : conversationTitle(selectedConversation)}
        >
          <TimelinePane
            getBackupClient={getBackupClient}
            getMediaClient={getMediaClient}
            record={record}
            runPreviewTask={runPreviewTask}
            selectedMessageId={selectedMessageId}
            state={timelineState}
            timelineRows={timelineRows}
            onLoadTimelinePage={(direction) => {
              void loadTimelinePage(direction);
            }}
            onSelectMessage={selectMessage}
          />
        </MessagesPane>

        <MessagesPane
          actions={
            <Button
              className="lg:hidden"
              onClick={closeDetail}
              size="sm"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" className="size-4" />
              Close
            </Button>
          }
          className={cn(
            "absolute inset-y-0 right-0 z-10 w-[min(var(--pane-detail),calc(100%_-_var(--space-16)))] border-l border-border shadow-2 lg:static lg:z-auto lg:w-auto lg:shadow-none",
            selectedMessageId === undefined && "hidden lg:flex",
          )}
          dialog={
            detailOverlayOpen
              ? { label: "Message details", onDismiss: closeDetail }
              : undefined
          }
          paneRef={detailPaneRef}
          title="Details"
        >
          <DetailPane
            navigate={navigate}
            record={record}
            state={detailState}
          />
        </MessagesPane>
      </div>
    </PageShell>
  );
}

function MessagesPane({
  actions,
  children,
  className,
  dialog,
  paneRef,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * When set, the pane is rendered as a modal dialog (used by the sub-lg
   * detail overlay): dialog semantics, programmatic focus target, and
   * Escape-to-dismiss.
   */
  dialog?: { label: string; onDismiss: () => void };
  paneRef?: Ref<HTMLElement>;
  title: string;
}) {
  return (
    <section
      aria-label={dialog?.label}
      aria-modal={dialog === undefined ? undefined : true}
      className={cn("flex h-[var(--layout-workspace-min)] min-w-0 flex-col bg-surface lg:h-auto", className)}
      onKeyDown={
        dialog === undefined
          ? undefined
          : (event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                dialog.onDismiss();
              }
            }
      }
      ref={paneRef}
      role={dialog === undefined ? undefined : "dialog"}
      tabIndex={dialog === undefined ? undefined : -1}
    >
      <div className="flex h-[var(--layout-pane-header)] shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <h2 className="truncate text-heading text-text">{title}</h2>
        {actions}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function ConversationPane({
  conversationsState,
  onLoadMoreConversations,
  onSelectConversation,
  selectedConversationId,
}: {
  conversationsState: ConversationsState;
  onLoadMoreConversations: () => void;
  onSelectConversation: (conversationId: string) => void;
  selectedConversationId: string | undefined;
}) {
  if (conversationsState.kind === "loading") {
    return (
      <PaneEmpty icon={<Loader2 aria-hidden="true" className="size-6" />}>
        Loading conversations.
      </PaneEmpty>
    );
  }

  if (conversationsState.kind === "error") {
    return (
      <div className="p-4">
        <InlineNotice kind="danger">{conversationsState.message}</InlineNotice>
      </div>
    );
  }

  if (conversationsState.conversations.length === 0) {
    return (
      <PaneEmpty icon={<MessageSquareText aria-hidden="true" className="size-6" />}>
        No conversations were extracted from this backup.
      </PaneEmpty>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="m3-conversation-list">
      <div className="min-h-0 flex-1">
        <Virtuoso
          className="h-full"
          data={conversationsState.conversations}
          itemContent={(_, conversation) => (
            <ConversationRow
              conversation={conversation}
              isSelected={conversation.id === selectedConversationId}
              onSelect={() => {
                onSelectConversation(conversation.id);
              }}
            />
          )}
        />
      </div>
      {conversationsState.moreError === undefined ? null : (
        <div className="border-t border-border p-3">
          <InlineNotice kind="danger">{conversationsState.moreError}</InlineNotice>
        </div>
      )}
      {conversationsState.conversations.length < conversationsState.total ? (
        <div className="border-t border-border p-3">
          <Button
            className="w-full"
            disabled={conversationsState.loadingMore}
            onClick={onLoadMoreConversations}
            size="sm"
            type="button"
            variant="secondary"
          >
            {conversationsState.loadingMore ? "Loading..." : "Load more threads"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ConversationRow({
  conversation,
  isSelected,
  onSelect,
}: {
  conversation: DbConversationSummary;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-current={isSelected ? "true" : undefined}
      className={cn(
        "relative block w-full border-b border-border px-4 py-3 text-left hover:bg-surface-raised",
        isSelected && "bg-accent-subtle pl-5 before:absolute before:left-0 before:top-0 before:h-full before:w-[var(--space-2)] before:bg-accent",
      )}
      data-testid={`conversation-${conversation.id}`}
      onClick={onSelect}
      type="button"
    >
      <span className="block truncate text-body font-[var(--font-weight-strong)] text-text">
        {conversationTitle(conversation)}
      </span>
      <span className="mt-1 block truncate text-caption text-text-secondary">
        {conversation.lastMessage?.bodyPreview ?? "No message preview"}
      </span>
      <span className="mt-2 flex items-center gap-2 text-micro text-text-tertiary">
        <span>{conversation.messageCount.toLocaleString()} messages</span>
        <span aria-hidden="true">/</span>
        <span>{formatDateTime(conversation.lastMessageAt)}</span>
      </span>
    </button>
  );
}

function TimelinePane({
  getBackupClient,
  getMediaClient,
  onLoadTimelinePage,
  onSelectMessage,
  record,
  runPreviewTask,
  selectedMessageId,
  state,
  timelineRows,
}: {
  getBackupClient: () => BackupWorkerClient;
  getMediaClient: () => MediaWorkerClient;
  onLoadTimelinePage: (direction: "after" | "before") => void;
  onSelectMessage: (messageId: string, conversationId: string) => void;
  record: RecentBackupRecord;
  runPreviewTask: RunPreviewTask;
  selectedMessageId: string | undefined;
  state: TimelineState;
  timelineRows: TimelineRow[];
}) {
  if (state.kind === "idle") {
    return (
      <PaneEmpty icon={<MessageSquareText aria-hidden="true" className="size-6" />}>
        Select a conversation to load its timeline.
      </PaneEmpty>
    );
  }

  if (state.kind === "loading") {
    return (
      <PaneEmpty icon={<Loader2 aria-hidden="true" className="size-6" />}>
        Loading message timeline.
      </PaneEmpty>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="p-4">
        <InlineNotice kind="danger">{state.message}</InlineNotice>
      </div>
    );
  }

  if (state.page.messages.length === 0) {
    return (
      <PaneEmpty icon={<MessageSquareText aria-hidden="true" className="size-6" />}>
        This conversation has no extracted messages.
      </PaneEmpty>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="m3-message-timeline">
      {state.page.hasMoreBefore ? (
        <div className="border-b border-border p-3">
          <Button
            className="w-full"
            disabled={state.loadingBefore}
            onClick={() => {
              onLoadTimelinePage("before");
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            {state.loadingBefore ? "Loading..." : "Load earlier messages"}
          </Button>
        </div>
      ) : null}
      {state.moreErrorBefore === undefined ? null : (
        <div className="border-b border-border p-3">
          <InlineNotice kind="danger">{state.moreErrorBefore}</InlineNotice>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Virtuoso
          className="h-full"
          data={timelineRows}
          firstItemIndex={state.firstItemIndex}
          initialTopMostItemIndex={findInitialTimelineIndex(
            timelineRows,
            state.page.anchorMessageId,
          )}
          itemContent={(_, row) =>
            row.kind === "day" ? (
              <DaySeparator label={row.label} />
            ) : (
              <MessageRow
                getBackupClient={getBackupClient}
                getMediaClient={getMediaClient}
                isSelected={row.message.id === selectedMessageId}
                message={row.message}
                record={record}
                runEnd={row.runEnd}
                runStart={row.runStart}
                runPreviewTask={runPreviewTask}
                onSelect={() => {
                  onSelectMessage(row.message.id, row.message.conversationId);
                }}
              />
            )
          }
        />
      </div>
      {state.moreErrorAfter === undefined ? null : (
        <div className="border-t border-border p-3">
          <InlineNotice kind="danger">{state.moreErrorAfter}</InlineNotice>
        </div>
      )}
      {state.page.hasMoreAfter ? (
        <div className="border-t border-border p-3">
          <Button
            className="w-full"
            disabled={state.loadingAfter}
            onClick={() => {
              onLoadTimelinePage("after");
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            {state.loadingAfter ? "Loading..." : "Load later messages"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DaySeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center px-4 py-4">
      <span className="rounded-full border border-border bg-surface px-3 py-1 text-micro text-text-tertiary">
        {label}
      </span>
    </div>
  );
}

function MessageRow({
  getBackupClient,
  getMediaClient,
  isSelected,
  message,
  onSelect,
  record,
  runEnd,
  runPreviewTask,
  runStart,
}: {
  getBackupClient: () => BackupWorkerClient;
  getMediaClient: () => MediaWorkerClient;
  isSelected: boolean;
  message: DbMessageRecord;
  onSelect: () => void;
  record: RecentBackupRecord;
  runEnd: boolean;
  runPreviewTask: RunPreviewTask;
  runStart: boolean;
}) {
  const senderName =
    message.sender === undefined
      ? message.isFromMe
        ? "Me"
        : "Unknown sender"
      : participantLabel(message.sender);
  const senderKey = message.sender?.handle ?? senderName;
  const isSent = message.isFromMe;

  if (message.isSystemEvent) {
    return (
      <button
        className={cn(
          "block w-full px-6 py-2 text-center",
          isSelected && "bg-accent-subtle",
        )}
        data-testid={`message-${String(message.sourceRowId)}`}
        onClick={onSelect}
        type="button"
      >
        <span className="text-caption text-text-secondary">{message.body}</span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        // Design.md section 7.1 run spacing: 2px gaps within a run (pt-0.5 on
        // non-run-start rows) and 8px between runs (pb-2 on run-end rows).
        "group block w-full px-6 text-left",
        runStart ? "pt-0" : "pt-0.5",
        runEnd ? "pb-2" : "pb-0",
        isSelected && "bg-accent-subtle",
      )}
      data-testid={`message-${String(message.sourceRowId)}`}
    >
      <span className={cn("flex gap-2", isSent ? "justify-end" : "justify-start")}>
        {!isSent && runStart ? <Avatar colorKey={senderKey} label={senderName} /> : null}
        {!isSent && !runStart ? (
          <span className="w-[var(--control-height-sm)] shrink-0" aria-hidden="true" />
        ) : null}
        <span
          className={cn(
            "flex max-w-[72%] flex-col",
            isSent ? "items-end" : "items-start",
          )}
        >
          {runStart ? (
            <span className="mb-1 text-caption text-text-tertiary">{senderName}</span>
          ) : null}
          <button
            className={cn(
              "relative min-w-[min(100%,calc(var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-24)_+_var(--space-4)))] rounded-bubble px-[calc(var(--space-12)_+_var(--space-2))] py-[calc(var(--space-8)_+_var(--space-2))] text-left text-body shadow-1",
              // Bubble color follows the normalized serviceKind (Design.md
              // section 7.1): sms-family is green; imessage and unknown share
              // the iMessage blue (Apple-default assumption).
              isSent
                ? message.serviceKind === "sms-family"
                  ? "bg-[var(--bubble-sms)] text-bubble-foreground"
                  : "bg-[var(--bubble-imessage)] text-bubble-foreground"
                : "border border-border bg-[var(--bubble-received)] text-text",
              // Tail-corner break on the run's last bubble, on the outer
              // (aligned) side: bottom-right for sent, bottom-left for
              // received.
              runEnd && (isSent ? "rounded-br-md" : "rounded-bl-md"),
            )}
            onClick={onSelect}
            type="button"
          >
            <span className="whitespace-pre-wrap break-words">{message.body}</span>
            {message.reactions.length > 0 ? (
              <span className="absolute -bottom-3 right-2 flex flex-wrap gap-1">
                {message.reactions.map((reaction) => (
                  <span
                    className="rounded-full border border-border bg-surface-raised px-2 py-0.5 text-micro text-text"
                    key={reaction.id}
                  >
                    {reactionLabel(reaction.kind)}
                  </span>
                ))}
              </span>
            ) : null}
          </button>
          {message.attachments.length > 0 ? (
            <span className="mt-3 grid max-w-full gap-2">
              {message.attachments.map((attachment) => (
                <AttachmentView
                  attachment={attachment}
                  getBackupClient={getBackupClient}
                  getMediaClient={getMediaClient}
                  key={attachment.id}
                  record={record}
                  runPreviewTask={runPreviewTask}
                />
              ))}
            </span>
          ) : null}
          {message.edited || message.unsent ? (
            <span className="mt-1 text-caption text-warning">
              {[message.edited ? "Edited" : undefined, message.unsent ? "Unsent" : undefined]
                .filter(Boolean)
                .join(" / ")}
            </span>
          ) : null}
          <span
            className={cn(
              "mt-1 text-caption text-text-tertiary opacity-0 transition-opacity duration-fast ease-out group-focus-within:opacity-100 group-hover:opacity-100",
              (runEnd || isSelected) && "opacity-100",
            )}
          >
            {formatDateTime(message.sentAtUtc)}
          </span>
          {message.reactions.length > 0 ? (
            <span className="mt-3 flex flex-wrap gap-1 text-caption text-text-secondary">
              {message.reactions.map((reaction) => (
                <span key={reaction.id}>
                  {reactionLabel(reaction.kind)} by{" "}
                  {reaction.sender === undefined
                    ? "Unknown"
                    : participantLabel(reaction.sender)}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </span>
    </div>
  );
}

function AttachmentView({
  attachment,
  getBackupClient,
  getMediaClient,
  record,
  runPreviewTask,
}: {
  attachment: DbAttachmentSummary;
  getBackupClient: () => BackupWorkerClient;
  getMediaClient: () => MediaWorkerClient;
  record: RecentBackupRecord;
  runPreviewTask: RunPreviewTask;
}) {
  const [previewState, setPreviewState] = useState<AttachmentPreviewState>({
    kind: "idle",
  });
  const [extractState, setExtractState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "permission-granted" }
    | { kind: "success" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const mountedRef = useRef(true);
  const previewRequestIdRef = useRef(0);
  const extractStubCleanupRef = useRef<(() => void) | undefined>(undefined);

  const canReadSource =
    attachment.sourceDomain !== undefined && attachment.sourcePath !== undefined;
  const commitPreviewState = useCallback(
    (requestId: number, nextState: AttachmentPreviewState): boolean => {
      if (!mountedRef.current || previewRequestIdRef.current !== requestId) {
        revokePreviewStateUrl(nextState);
        return false;
      }

      setPreviewState(nextState);
      return true;
    },
    [],
  );
  const setExtractStateIfMounted = useCallback(
    (nextState: typeof extractState) => {
      if (mountedRef.current) {
        setExtractState(nextState);
      }
    },
    [],
  );

  useEffect(() => {
    // Reset on every mount so a StrictMode unmount/remount cycle does not
    // leave the component permanently marked unmounted.
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      previewRequestIdRef.current += 1;
      // If an extraction is mid-read on unmount the route's backup worker may
      // already be terminated, leaving the read promise forever pending —
      // remove the zero-byte picker stub best-effort now.
      extractStubCleanupRef.current?.();
      extractStubCleanupRef.current = undefined;
    };
  }, []);

  const loadPreview = useCallback(
    async (requestPermission: boolean) => {
      const requestId = previewRequestIdRef.current + 1;

      previewRequestIdRef.current = requestId;

      if (!isInlinePreviewMediaKind(attachment.mediaKind)) {
        return;
      }

      commitPreviewState(requestId, { kind: "loading" });

      if (isThumbnailPreviewMediaKind(attachment.mediaKind)) {
        // Cache probes intentionally bypass the preview concurrency limiter:
        // they only read small cached thumbnail files from OPFS (never the
        // source backup), so unbounded probes stay cheap and cached previews
        // render without queueing behind large source reads.
        let cachedResult:
          | Awaited<
              ReturnType<
                MediaWorkerClient["api"]["getCachedAttachmentThumbnail"]
              >
            >
          | undefined;

        try {
          const mediaClient = getMediaClient();
          cachedResult = await mediaClient.api.getCachedAttachmentThumbnail({
            backupId: record.id,
            cacheKey: attachment.thumbnailCacheKey,
            mediaKind: attachment.mediaKind,
          });
        } catch {
          cachedResult = undefined;
        }

        if (!mountedRef.current || previewRequestIdRef.current !== requestId) {
          if (cachedResult?.ok === true && cachedResult.value.status === "ok") {
            revokePreviewStateUrl(createThumbnailPreviewState(cachedResult.value));
          }
          return;
        }

        if (cachedResult?.ok === true && cachedResult.value.status === "ok") {
          commitPreviewState(
            requestId,
            createThumbnailPreviewState(cachedResult.value),
          );
          return;
        }
      }

      if (!canReadSource) {
        commitPreviewState(requestId, {
          kind: "unsupported",
          message: "Preview unavailable because source provenance is incomplete.",
        });
        return;
      }

      const permission = await ensureRecentBackupDirectoryPermission(record, {
        request: requestPermission,
      });

      if (permission !== "granted") {
        commitPreviewState(requestId, { kind: "needs-permission" });
        return;
      }

      try {
        await runPreviewTask(async () => {
          // Re-check at task start: the request may have been superseded (or
          // the row unmounted) while queued behind the concurrency limiter,
          // in which case the full source read must be skipped.
          if (!mountedRef.current || previewRequestIdRef.current !== requestId) {
            return;
          }

          const backupClient = getBackupClient();
          const sourceResult = await backupClient.api.readUnencryptedSourceFile(
            record.directoryHandle,
            {
              backupId: record.id,
              expectedSha256: attachment.sha256,
              filename: attachment.filename,
              maxReadBytes:
                attachment.mediaKind === "video"
                  ? previewVideoMaxBytes
                  : previewImageMaxBytes,
              mime: attachment.mime,
              sourceDomain: attachment.sourceDomain ?? "",
              sourceGuid: attachment.sourceGuid,
              sourcePath: attachment.sourcePath ?? "",
            },
          );

          if (!sourceResult.ok) {
            commitPreviewState(requestId, {
              kind: "error",
              message: formatWorkerResultError(sourceResult.error),
            });
            return;
          }

          if (attachment.mediaKind === "video") {
            commitPreviewState(
              requestId,
              createOriginalMediaPreviewState(
                "video",
                sourceResult.value.bytes,
                sourceResult.value.mime ?? attachment.mime,
              ),
            );
            return;
          }

          const mediaClient = getMediaClient();
          // Must be created before the transfer() below detaches the buffer.
          const originalPreview = attachment.mediaKind === "image"
            ? createOriginalMediaPreviewState(
                "image",
                sourceResult.value.bytes,
                sourceResult.value.mime ?? attachment.mime,
              )
            : undefined;
          let originalPreviewHandled = false;
          // Single owner of the thumbnail-failure decision: fall back to the
          // original image (with an explanatory caption) when one exists,
          // otherwise surface the failure state. Marks the original preview
          // handled so the finally block below does not double-revoke its
          // blob URL (a stale commit revokes it inside commitPreviewState).
          const commitThumbnailFallback = (
            reason: "failed" | "unsupported",
            detail: string,
          ) => {
            if (originalPreview === undefined) {
              commitPreviewState(
                requestId,
                reason === "unsupported"
                  ? { kind: "unsupported", message: detail }
                  : {
                      kind: "error",
                      message: `HEIC thumbnail generation failed: ${detail}`,
                    },
              );
              return;
            }

            commitPreviewState(requestId, {
              ...originalPreview,
              caption: `Showing original image because thumbnail generation ${
                reason === "unsupported" ? "is unsupported" : "failed"
              }: ${detail}`,
            });
            originalPreviewHandled = true;
          };

          try {
            const thumbnailResult = await mediaClient.api.createAttachmentThumbnail(
              transfer(
                {
                  backupId: record.id,
                  bytes: sourceResult.value.bytes,
                  cacheKey: attachment.thumbnailCacheKey,
                  mediaKind: attachment.mediaKind,
                  mime: attachment.mime,
                  maxPixelSize: defaultThumbnailMaxPixelSize,
                },
                [sourceResult.value.bytes.buffer as ArrayBuffer],
              ),
            );

            if (!thumbnailResult.ok) {
              commitThumbnailFallback(
                "failed",
                formatWorkerResultError(thumbnailResult.error),
              );
              return;
            }

            if (thumbnailResult.value.status === "unsupported") {
              commitThumbnailFallback(
                "unsupported",
                thumbnailResult.value.message,
              );
              return;
            }

            const thumbnailPreview = createThumbnailPreviewState(
              thumbnailResult.value,
            );

            if (commitPreviewState(requestId, thumbnailPreview)) {
              if (originalPreview !== undefined) {
                URL.revokeObjectURL(originalPreview.url);
              }
              originalPreviewHandled = true;
            }
          } catch (cause) {
            commitThumbnailFallback("failed", formatError(cause));
          } finally {
            if (originalPreview !== undefined && !originalPreviewHandled) {
              URL.revokeObjectURL(originalPreview.url);
            }
          }
        });
      } catch (cause) {
        commitPreviewState(requestId, { kind: "error", message: formatError(cause) });
      }
    },
    [
      attachment,
      canReadSource,
      commitPreviewState,
      getBackupClient,
      getMediaClient,
      record,
      runPreviewTask,
    ],
  );

  useEffect(() => {
    previewRequestIdRef.current += 1;

    if (attachment.mediaKind === "video") {
      setPreviewState({ kind: "idle" });
      return;
    }

    if (!isThumbnailPreviewMediaKind(attachment.mediaKind)) {
      setPreviewState({
        kind: "unsupported",
        message: unsupportedAttachmentMessage(attachment),
      });
      return;
    }

    void loadPreview(false);
  }, [attachment, attachment.mediaKind, loadPreview]);

  useEffect(
    () => () => {
      if (previewState.kind === "image" || previewState.kind === "video") {
        URL.revokeObjectURL(previewState.url);
      }
    },
    [previewState],
  );

  const extractOriginal = async () => {
    if (!canReadSource) {
      setExtractStateIfMounted({
        kind: "error",
        message: "Cannot extract this attachment because source provenance is incomplete.",
      });
      return;
    }

    setExtractStateIfMounted({ kind: "running" });

    try {
      // Check the stored permission first so an already-granted grant goes
      // straight to the picker; otherwise spend this click's user activation
      // on the permission prompt before opening the picker.
      let permission = await ensureRecentBackupDirectoryPermission(record, {
        request: false,
      });
      let requestedPermission = false;

      if (permission !== "granted") {
        requestedPermission = true;
        permission = await ensureRecentBackupDirectoryPermission(record, {
          request: true,
        });
      }

      if (permission !== "granted") {
        setExtractStateIfMounted({
          kind: "error",
          message: `Chrome did not grant read access to ${record.friendlyName}.`,
        });
        return;
      }

      if (requestedPermission && !navigator.userActivation.isActive) {
        // The permission prompt consumed this click's transient user
        // activation, so showSaveFilePicker would reject with a
        // SecurityError. Stop here with a non-error notice instead of
        // surfacing a confusing failure; the next click goes straight to
        // the picker because permission is now granted.
        setExtractStateIfMounted({ kind: "permission-granted" });
        return;
      }

      const fileHandle = await window.showSaveFilePicker({
        suggestedName: attachment.filename ?? "attachment",
        types:
          attachment.mime === undefined
            ? undefined
            : [
                {
                  accept: { [attachment.mime]: [extensionForAttachment(attachment)] },
                  description: attachment.mime,
                },
              ],
      });

      // Chrome creates the destination file as soon as the picker resolves.
      // Until a write commits, treat it as a zero-byte stub that must be
      // removed on any failure — including unmount, where the terminated
      // backup worker leaves the read promise forever pending (the mount
      // effect's cleanup invokes this ref).
      let stubPending = true;
      const removeStub = async () => {
        if (!stubPending) {
          return;
        }

        stubPending = false;
        extractStubCleanupRef.current = undefined;

        try {
          await fileHandle.remove();
        } catch {
          // Best-effort cleanup: a removal failure must not mask the
          // original extraction error.
        }
      };

      extractStubCleanupRef.current = () => {
        void removeStub();
      };

      try {
        const backupClient = getBackupClient();
        const sourceResult = await backupClient.api.readUnencryptedSourceFile(
          record.directoryHandle,
          {
            backupId: record.id,
            expectedSha256: attachment.sha256,
            filename: attachment.filename,
            maxReadBytes: extractMaxReadBytes,
            mime: attachment.mime,
            sourceDomain: attachment.sourceDomain ?? "",
            sourceGuid: attachment.sourceGuid,
            sourcePath: attachment.sourcePath ?? "",
          },
        );

        if (!sourceResult.ok) {
          setExtractStateIfMounted({
            kind: "error",
            message: formatWorkerResultError(sourceResult.error),
          });
          return;
        }

        const writable = await fileHandle.createWritable();

        try {
          await writable.write(sourceResult.value.bytes as Uint8Array<ArrayBuffer>);
        } finally {
          await writable.close();
        }

        // The write committed — keep the file.
        stubPending = false;
        extractStubCleanupRef.current = undefined;
        setExtractStateIfMounted({ kind: "success" });
      } finally {
        // No-op when the write committed; otherwise removes the stub before
        // the caller sees the failure state.
        await removeStub();
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        setExtractStateIfMounted({ kind: "idle" });
        return;
      }

      setExtractStateIfMounted({ kind: "error", message: formatError(cause) });
    }
  };

  return (
    <span className="block max-w-[calc(var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64))] rounded-md border border-border bg-surface px-3 py-3 text-left shadow-1">
      <span className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-[var(--control-height-md)] shrink-0 items-center justify-center rounded-md bg-surface-sunken text-text-tertiary">
          {attachment.mediaKind === "video" ? (
            <Video aria-hidden="true" className="size-4" />
          ) : (
            <Image aria-hidden="true" className="size-4" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-[var(--font-weight-strong)] text-text">
            {attachment.filename ?? "Unnamed attachment"}
          </span>
          <span className="mt-1 block text-caption text-text-secondary">
            {attachment.mediaKind} / {formatBytes(attachment.bytes)}
          </span>
        </span>
      </span>

      <span className="mt-3 block">
        {previewState.kind === "image" ? (
          <>
            <img
              alt={attachment.filename ?? "Attachment preview"}
              className="max-h-[calc(var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64))] max-w-[calc(var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64))] rounded-md border border-border object-contain"
              height={previewState.height}
              src={previewState.url}
              width={previewState.width}
            />
            {previewState.caption === undefined ? null : (
              <span className="mt-2 block text-caption text-text-secondary">
                {previewState.caption}
              </span>
            )}
          </>
        ) : previewState.kind === "video" ? (
          <video
            className="max-h-[calc(var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64))] max-w-[calc(var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64))] rounded-md border border-border bg-surface-sunken"
            controls
            preload="metadata"
            src={previewState.url}
          >
            Video preview is unavailable in this browser runtime.
          </video>
        ) : previewState.kind === "loading" ? (
          <span className="text-caption text-text-secondary">Loading preview.</span>
        ) : previewState.kind === "needs-permission" ? (
          <Button
            onClick={() => {
              void loadPreview(true);
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            Load preview
          </Button>
        ) : previewState.kind === "unsupported" ? (
          <span className="text-caption text-text-secondary">{previewState.message}</span>
        ) : previewState.kind === "error" ? (
          <span className="text-caption text-danger">{previewState.message}</span>
        ) : attachment.mediaKind === "video" ? (
          <Button
            onClick={() => {
              void loadPreview(true);
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            <Video aria-hidden="true" className="size-4" />
            Load video preview
          </Button>
        ) : null}
      </span>

      <span className="mt-3 flex items-center gap-2">
        <Button
          disabled={!canReadSource || extractState.kind === "running"}
          onClick={() => {
            void extractOriginal();
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          <Download aria-hidden="true" className="size-4" />
          Extract original
        </Button>
        {extractState.kind === "success" ? (
          <span className="text-caption text-success">Saved</span>
        ) : null}
      </span>
      {extractState.kind === "permission-granted" ? (
        <span
          className="mt-2 block rounded-md bg-[var(--info-subtle)] px-3 py-2 text-caption text-[var(--info-foreground)]"
          role="status"
        >
          Chrome granted read access to {record.friendlyName}. Click Extract
          original again to choose where to save the file.
        </span>
      ) : null}
      {extractState.kind === "error" ? (
        <span className="mt-2 block text-caption text-danger">{extractState.message}</span>
      ) : null}
    </span>
  );
}

function DetailPane({
  navigate,
  record,
  state,
}: {
  navigate: ReturnType<typeof useNavigate>;
  record: RecentBackupRecord;
  state: DetailState;
}) {
  if (state.kind === "empty") {
    return (
      <PaneEmpty icon={<FileWarning aria-hidden="true" className="size-6" />}>
        Select a message to inspect provenance and source metadata.
      </PaneEmpty>
    );
  }

  if (state.kind === "loading") {
    return (
      <PaneEmpty icon={<Loader2 aria-hidden="true" className="size-6" />}>
        Loading message details.
      </PaneEmpty>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="p-4">
        <InlineNotice kind="danger">{state.message}</InlineNotice>
      </div>
    );
  }

  const message = state.details.message;
  const conversation = state.details.conversation;

  return (
    <div className="h-full overflow-auto p-4" data-testid="m3-message-detail">
      <div className="grid gap-3">
        <section>
          <h3 className="text-heading text-text">Message metadata</h3>
          <dl className="mt-3 grid gap-3">
            <DataRow label="Message id" value={message.id} />
            <DataRow label="Conversation" value={conversationTitle(conversation)} />
            <DataRow label="Sender" value={message.sender === undefined ? undefined : participantLabel(message.sender)} />
            <DataRow label="Direction" value={message.isFromMe ? "Sent" : "Received"} />
            <DataRow label="Service" value={message.service} />
            <DataRow label="Sent at" value={formatDateTime(message.sentAtUtc)} />
            <DataRow label="Delivered at" value={formatDateTime(message.dateDelivered)} />
            <DataRow label="Read at" value={formatDateTime(message.dateRead)} />
            <DataRow label="Raw timestamp" value={message.rawTimestamp} />
            <DataRow label="Source GUID" value={message.sourceGuid} />
            <DataRow label="Source row id" value={message.sourceRowId} />
            <DataRow label="Edited" value={message.edited} />
            <DataRow label="Unsent" value={message.unsent} />
            <DataRow label="System event" value={message.isSystemEvent} />
          </dl>
        </section>

        <section>
          <h3 className="text-heading text-text">Participants</h3>
          <dl className="mt-3 grid gap-3">
            {conversation.participants.map((participant) => (
              <DataRow
                key={participant.id}
                label={participantLabel(participant)}
                value={`${participant.handle}${participant.isSelf ? " / self" : ""}`}
              />
            ))}
          </dl>
        </section>

        <section>
          <h3 className="text-heading text-text">Attachments provenance</h3>
          {message.attachments.length === 0 ? (
            <p className="mt-2 text-caption text-text-secondary">No attachments.</p>
          ) : (
            <div className="mt-3 grid gap-3">
              {message.attachments.map((attachment) => (
                <div
                  className="rounded-md border border-border bg-surface-sunken p-3"
                  key={attachment.id}
                >
                  <p className="truncate text-body font-[var(--font-weight-strong)] text-text">
                    {attachment.filename ?? attachment.id}
                  </p>
                  <dl className="mt-2 grid gap-2">
                    <DataRow label="Source domain" value={attachment.sourceDomain} />
                    <DataRow label="Source path" value={attachment.sourcePath} />
                    <DataRow label="Source GUID" value={attachment.sourceGuid} />
                    <DataRow label="SHA-256" value={attachment.sha256} />
                    <DataRow label="Media kind" value={attachment.mediaKind} />
                    <DataRow label="Byte length" value={attachment.bytes} />
                  </dl>
                </div>
              ))}
            </div>
          )}
        </section>

        <Button
          onClick={() => {
            void navigate(
              `/backup/${encodeURIComponent(record.id)}/search?conversation=${encodeURIComponent(message.conversationId)}`,
            );
          }}
          type="button"
          variant="secondary"
        >
          Search this conversation
        </Button>
      </div>
    </div>
  );
}

function PaneEmpty({
  children,
  icon,
}: {
  children: ReactNode;
  icon: ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <EmptyState icon={icon}>{children}</EmptyState>
    </div>
  );
}

function Avatar({ colorKey, label }: { colorKey: string; label: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-[var(--control-height-sm)] shrink-0 items-center justify-center rounded-full text-caption font-[var(--font-weight-strong)] text-avatar-foreground",
        avatarColorClass(colorKey),
      )}
    >
      {label.slice(0, 1).toLocaleUpperCase()}
    </span>
  );
}

function avatarColorClass(value: string): string {
  switch (stableStringHash(value) % 8) {
    case 0:
      return "bg-[var(--avatar-1)]";
    case 1:
      return "bg-[var(--avatar-2)]";
    case 2:
      return "bg-[var(--avatar-3)]";
    case 3:
      return "bg-[var(--avatar-4)]";
    case 4:
      return "bg-[var(--avatar-5)]";
    case 5:
      return "bg-[var(--avatar-6)]";
    case 6:
      return "bg-[var(--avatar-7)]";
    default:
      return "bg-[var(--avatar-8)]";
  }
}

function stableStringHash(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function buildTimelineRows(messages: readonly DbMessageRecord[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let previousDay = "";

  messages.forEach((message, index) => {
    const day = formatDay(message.sentAtUtc);

    if (day !== previousDay) {
      rows.push({ kind: "day", id: `day-${day}-${message.id}`, label: day });
      previousDay = day;
    }

    const previous = messages[index - 1];
    const next = messages[index + 1];

    rows.push({
      kind: "message",
      id: message.id,
      message,
      runStart: !isSameSenderRun(previous, message),
      runEnd: !isSameSenderRun(message, next),
    });
  });

  return rows;
}

function isSameSenderRun(
  left: DbMessageRecord | undefined,
  right: DbMessageRecord | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }

  if (left.senderId !== right.senderId || left.isFromMe !== right.isFromMe) {
    return false;
  }

  const leftTime = left.sentAtUtc === undefined ? Number.NaN : Date.parse(left.sentAtUtc);
  const rightTime =
    right.sentAtUtc === undefined ? Number.NaN : Date.parse(right.sentAtUtc);

  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return false;
  }

  return Math.abs(rightTime - leftTime) <= 60_000;
}

function findInitialTimelineIndex(
  rows: readonly TimelineRow[],
  messageId: string | undefined,
): number {
  if (messageId === undefined) {
    return 0;
  }

  const index = rows.findIndex((row) => row.kind === "message" && row.id === messageId);

  return index < 0 ? 0 : index;
}

function reactionLabel(kind: string): string {
  switch (kind) {
    case "loved":
      return "Loved";
    case "liked":
      return "Liked";
    case "disliked":
      return "Disliked";
    case "laughed":
      return "Laughed";
    case "emphasized":
      return "Emphasized";
    case "questioned":
      return "Questioned";
    default:
      return "Reacted";
  }
}

function unsupportedAttachmentMessage(attachment: DbAttachmentSummary): string {
  switch (attachment.mediaKind) {
    case "heic":
      return "HEIC preview is unavailable.";
    case "video":
      return "Video preview requires source permission.";
    case "file":
      return "No inline preview is available for this file.";
    case "image":
      return "Image preview is unavailable.";
  }
}

type OriginalMediaPreviewState =
  | { kind: "image"; caption?: string; url: string }
  | { kind: "video"; url: string };

function createOriginalMediaPreviewState(
  kind: "image",
  bytes: Uint8Array,
  mime: string | undefined,
): { kind: "image"; caption?: string; url: string };
function createOriginalMediaPreviewState(
  kind: "video",
  bytes: Uint8Array,
  mime: string | undefined,
): { kind: "video"; url: string };
function createOriginalMediaPreviewState(
  kind: "image" | "video",
  bytes: Uint8Array,
  mime: string | undefined,
): OriginalMediaPreviewState {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
    type: mime ?? "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);

  return kind === "image" ? { kind: "image", url } : { kind: "video", url };
}

function createThumbnailPreviewState(
  thumbnail: AttachmentThumbnailOkResponse,
): AttachmentPreviewState {
  const blob = new Blob([thumbnail.bytes as Uint8Array<ArrayBuffer>], {
    type: thumbnail.mime,
  });

  return {
    kind: "image",
    height: thumbnail.height,
    url: URL.createObjectURL(blob),
    width: thumbnail.width,
  };
}

function revokePreviewStateUrl(state: AttachmentPreviewState): void {
  if (state.kind === "image" || state.kind === "video") {
    URL.revokeObjectURL(state.url);
  }
}

function extensionForAttachment(attachment: DbAttachmentSummary): string {
  const filename = attachment.filename;

  if (filename === undefined) {
    return ".bin";
  }

  const dotIndex = filename.lastIndexOf(".");

  if (dotIndex < 0 || dotIndex === filename.length - 1) {
    return ".bin";
  }

  return filename.slice(dotIndex);
}

function createPreviewTaskRunner(limit: number): PreviewTaskRunner {
  const queue: {
    reject: (cause: unknown) => void;
    run: () => void;
  }[] = [];
  let activeCount = 0;
  let cancelled = false;

  const runNext = () => {
    if (cancelled || activeCount >= limit) {
      return;
    }

    const next = queue.shift();

    if (next === undefined) {
      return;
    }

    activeCount += 1;
    next.run();
  };

  const runner = (<TResult,>(task: () => Promise<TResult>) =>
    new Promise<TResult>((resolve, reject) => {
      const run = () => {
        if (cancelled) {
          reject(new Error("Preview task cancelled."));
          activeCount -= 1;
          runNext();
          return;
        }

        // Route the task through a resolved promise so a synchronous throw
        // still rejects the caller and releases the concurrency slot.
        void Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            activeCount -= 1;
            runNext();
          });
      };

      queue.push({ reject, run });
      runNext();
    })) as PreviewTaskRunner;

  runner.cancel = () => {
    cancelled = true;

    while (queue.length > 0) {
      const queued = queue.shift();

      queued?.reject(new Error("Preview task cancelled."));
    }
  };

  return runner;
}
