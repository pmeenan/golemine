import {
  ArrowLeft,
  CircleAlert,
  Download,
  FileWarning,
  Image,
  ImageOff,
  LockKeyhole,
  Loader2,
  MessageSquareText,
  Search,
  Video,
  X,
} from "lucide-react";
import { transfer } from "comlink";
import {
  type Dispatch,
  type SetStateAction,
  type SyntheticEvent,
  type ReactNode,
  type Ref,
  Fragment,
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link, useParams, useSearchParams } from "react-router";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import {
  BackupPasswordForm,
  type BackupPasswordFormController,
  useBackupPasswordForm,
} from "../../components/backup/backup-password-form";
import { EmptyState, PageShell } from "../../components/layout/page-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { DateRangePicker } from "../../components/ui/date-range-picker";
import type { DateRangeValue } from "../../components/ui/date-range";
import { useModalFocusContainment } from "../../components/ui/modal-focus";
import { cn } from "../../lib/cn";
import {
  ensureRecentBackupDirectoryPermission,
  type RecentBackupRecord,
} from "../../lib/recents";
import {
  createBackupWorkerClient,
  createDbWorkerClient,
  createMediaWorkerClient,
  proxiedWorkerProgress,
} from "../../lib/worker-client";
import type {
  AttachmentThumbnailOkResponse,
  DbAttachmentSummary,
  DbConversationSummary,
  DbSearchConversationSummary,
  DbMessageRecord,
  ListSearchConversationsResponse,
  MessageDetailsResponse,
  MessageTimelinePageResponse,
  SearchConversationFilters,
  SearchMessageResult,
  SearchMessagesResponse,
  WorkerResult,
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
  formatBytes,
  formatDateTime,
  formatDay,
  formatError,
  formatWorkerResultError,
  InlineNotice,
  isInlinePreviewMediaKind,
  isThumbnailPreviewMediaKind,
  mergeBy,
  mergeById,
  participantLabel,
  RecentRouteGate,
  useConversationPages,
  useRecentRouteState,
  useVirtuosoJump,
} from "./m3-shared";
import {
  includePinnedSearchResult,
  selectScopedCachedSearchResult,
} from "./search-result-pinning";

const conversationPageSize = 100;
const searchPageSize = 100;
const timelinePageSize = 100;
const timelineInitialFirstItemIndex = 100_000;
const previewConcurrency = 2;

/**
 * Shared list-row treatment for the threads/results panes; the selected
 * state renders the Design.md accent bar. Rows may override the paddings
 * (cn resolves the conflict in favor of the later class).
 */
const listRowClass =
  "relative block w-full border-b border-border px-3 py-3 text-left hover:bg-surface-raised";
const listRowSelectedClass =
  "bg-accent-subtle pl-4 before:absolute before:left-0 before:top-0 before:h-full before:w-[var(--space-2)] before:bg-accent";

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

interface ActiveSearch {
  filters: SearchConversationFilters;
  text: string;
  token: number;
}

/** Draft form values lifted out of SearchPanel only on submit. */
interface SearchDraft {
  fromDate: string;
  hasAttachment: boolean;
  participantQuery: string;
  query: string;
  toDate: string;
}

/**
 * One paged-search state machine shared by the threads and results panes: a
 * stale `response` stays displayed through loading/error so replacement
 * searches never blank the workspace.
 */
type SearchPaneState<TResponse> =
  | { kind: "idle" }
  | { kind: "loading"; response?: TResponse }
  | { kind: "error"; message: string; response?: TResponse }
  | {
      kind: "ready";
      loadingMore: boolean;
      moreError?: string;
      response: TResponse;
    };

type SearchThreadsState = SearchPaneState<ListSearchConversationsResponse>;
type SearchResultsState = SearchPaneState<SearchMessagesResponse>;

/** Where the detail-opening activation came from, for focus return. */
type DetailReturnOrigin = "message" | "search-result";

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
  | { kind: "needs-password" }
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

type EncryptedSessionState =
  | { kind: "locked" }
  | { kind: "unlocking"; label: string }
  | { kind: "locking"; label: string }
  | { kind: "unlocked"; revision: number }
  | { kind: "error"; message: string };

interface EncryptedSessionContextValue {
  focusUnlock: () => void;
  isEncrypted: boolean;
  isUnlocked: boolean;
  requireUnlock: () => void;
  revision: number;
}

const EncryptedSessionContext = createContext<EncryptedSessionContextValue>({
  focusUnlock: () => undefined,
  isEncrypted: false,
  isUnlocked: true,
  requireUnlock: () => undefined,
  revision: 0,
});

function isRouteActive(ref: { readonly current: boolean }): boolean {
  return ref.current;
}

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
  const selectedConversationId = searchParams.get("conversation") ?? undefined;
  const selectedMessageId = searchParams.get("message") ?? undefined;
  const [activeSearch, setActiveSearch] = useState<ActiveSearch | undefined>();
  const [isSubmittingSearch, setIsSubmittingSearch] = useState(false);
  const [searchSubmissionError, setSearchSubmissionError] = useState<
    string | undefined
  >();
  const [scopeRequestVersion, setScopeRequestVersion] = useState(0);
  const [searchThreadsState, setSearchThreadsState] =
    useState<SearchThreadsState>({ kind: "idle" });
  const [searchResultsState, setSearchResultsState] =
    useState<SearchResultsState>({ kind: "idle" });
  const [timelineState, setTimelineState] = useState<TimelineState>({
    kind: "idle",
  });
  const [detailState, setDetailState] = useState<DetailState>({ kind: "empty" });
  const [encryptedSessionState, setEncryptedSessionState] =
    useState<EncryptedSessionState>(() =>
      record.isEncrypted ? { kind: "locked" } : { kind: "unlocked", revision: 0 },
    );
  // Lazily initialized from the dock media query so a cold deep link below
  // the dock threshold renders the Details pane as a modal overlay on the
  // very first frame instead of briefly auto-placing it in the grid.
  const [detailOverlayActive, setDetailOverlayActive] = useState(
    () => !detailDockMediaQuery().matches,
  );
  const [activatedSearchResults, setActivatedSearchResults] = useState<
    ReadonlyMap<string, SearchMessageResult>
  >(() => new Map());
  const [searchResultActivationRevision, setSearchResultActivationRevision] =
    useState(0);
  const timelineStateRef = useRef<TimelineState>(timelineState);
  const dbClientRef = useRef<DbWorkerClient | undefined>(undefined);
  const backupClientRef = useRef<BackupWorkerClient | undefined>(undefined);
  const mediaClientRef = useRef<MediaWorkerClient | undefined>(undefined);
  const previewRunnerRef = useRef<PreviewTaskRunner | undefined>(undefined);
  const searchTokenRef = useRef(0);
  const resultsRequestKeyRef = useRef("");
  const displayedResultsKeyRef = useRef("");
  const displayedResultsScopeConversationIdRef =
    useRef<string | undefined>(undefined);
  // Set while a replacement search's URL cleanup (deleting the pre-submit
  // conversation selection) is still committing through the router
  // transition; the scoped-results effect skips that transient stale scope.
  const pendingScopeClearRef =
    useRef<{ conversationId: string; token: number } | undefined>(undefined);
  const searchResultsStateRef = useRef<SearchResultsState>(searchResultsState);
  const detailPaneRef = useRef<HTMLElement | null>(null);
  const detailReturnFocusRef = useRef<HTMLElement | undefined>(undefined);
  const detailReturnFocusMessageIdRef = useRef<string | undefined>(undefined);
  const detailReturnFocusOriginRef =
    useRef<DetailReturnOrigin | undefined>(undefined);
  const wasDetailOpenRef = useRef(false);
  const previousDetailModeRef =
    useRef<"docked" | "overlay" | undefined>(undefined);
  const encryptedPasswordForm = useBackupPasswordForm();
  const encryptedUnlockInFlightRef = useRef(false);
  const routeActiveRef = useRef(true);
  const focusUnlockAfterDetailCloseRef = useRef(false);
  const detailOverlayOpenRef = useRef(false);
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
  const unlockEncryptedSession = useCallback(
    async () => {
      if (encryptedUnlockInFlightRef.current) {
        return;
      }

      encryptedUnlockInFlightRef.current = true;
      setEncryptedSessionState({
        kind: "unlocking",
        label: "Checking the backup password.",
      });

      try {
        const permission = await ensureRecentBackupDirectoryPermission(record, {
          request: true,
        });

        if (!isRouteActive(routeActiveRef)) {
          encryptedPasswordForm.clear();
          return;
        }

        if (permission !== "granted") {
          encryptedPasswordForm.clear();
          setEncryptedSessionState({
            kind: "error",
            message: `Chrome did not grant read access to ${record.friendlyName}.`,
          });
          encryptedPasswordForm.focusAfterFrame();
          return;
        }

        const client = getBackupClient();
        const progress = proxiedWorkerProgress((update) => {
          if (!isRouteActive(routeActiveRef)) {
            return;
          }
          setEncryptedSessionState({
            kind: "unlocking",
            label: update.label,
          });
        });
        // The shared controller reads the uncontrolled field and clears it
        // before any await; the worker RPC receives the credential in the
        // same synchronous call. A backup_password_incorrect result refocuses
        // the cleared field for an in-place retry.
        // (async so the union-of-promises Comlink return type collapses to a
        // promise of the WorkerResult union; the RPC call itself still runs
        // synchronously when the controller invokes this dispatch.)
        const result = await encryptedPasswordForm.submitWithPassword(
          async (password) =>
            client.api.unlockBackupSession(
              record.directoryHandle,
              { backupId: record.id, password },
              progress,
            ),
          {
            emptyPasswordMessage:
              "Enter the backup password before unlocking attachments.",
          },
        );

        if (!isRouteActive(routeActiveRef)) {
          return;
        }

        if (!result.ok) {
          setEncryptedSessionState({
            kind: "error",
            message: formatWorkerResultError(result.error),
          });
          return;
        }

        setEncryptedSessionState((current) => ({
          kind: "unlocked",
          revision: current.kind === "unlocked" ? current.revision + 1 : 1,
        }));
      } catch (cause) {
        encryptedPasswordForm.clear();
        if (!isRouteActive(routeActiveRef)) {
          return;
        }
        setEncryptedSessionState({
          kind: "error",
          message: formatError(cause),
        });
        encryptedPasswordForm.focusAfterFrame();
      } finally {
        encryptedUnlockInFlightRef.current = false;
      }
    },
    [encryptedPasswordForm, getBackupClient, record],
  );
  const lockEncryptedSession = useCallback(async () => {
    if (encryptedUnlockInFlightRef.current) {
      return;
    }

    encryptedUnlockInFlightRef.current = true;
    setEncryptedSessionState({
      kind: "locking",
      label: "Clearing attachment decryption keys.",
    });

    const client = backupClientRef.current;

    try {
      await client?.api.lockBackupSession();
    } catch {
      // Terminating the route worker is the secure fallback if its explicit
      // lock RPC fails. A later unlock lazily creates a fresh worker.
      client?.release();
      backupClientRef.current = undefined;
      // Comlink never settles in-flight RPC promises on terminate, so preview
      // tasks awaiting readSourceFile on the terminated worker are stranded
      // and would hold the shared limiter's active slots forever. Retire the
      // whole runner: reject queued tasks now and let the next preview lazily
      // create a fresh limiter. Stranded tasks only ever release the retired
      // runner's slots, and any late preview commits are dropped by the
      // per-attachment request-id guard bumped when the session locks.
      previewRunnerRef.current?.cancel();
      previewRunnerRef.current = undefined;
    } finally {
      encryptedUnlockInFlightRef.current = false;
      if (isRouteActive(routeActiveRef)) {
        setEncryptedSessionState({ kind: "locked" });
        encryptedPasswordForm.focusAfterFrame();
      }
    }
  }, [encryptedPasswordForm]);
  const focusDetailReturnTarget = useCallback(() => {
    // Virtualized triggers unmount and remount as new elements, so the
    // activated message id (not a stale element reference or test hook) is
    // the durable identity: prefer the re-found trigger, then the matching
    // timeline bubble, then the original element if it is still connected.
    const messageId = detailReturnFocusMessageIdRef.current;
    const findByAttribute = (attribute: string): HTMLElement | undefined =>
      messageId === undefined
        ? undefined
        : (document.querySelector<HTMLElement>(
            `[${attribute}="${CSS.escape(messageId)}"]`,
          ) ?? undefined);
    const recordedTarget = detailReturnFocusRef.current;

    (
      (detailReturnFocusOriginRef.current === "search-result"
        ? findByAttribute("data-search-result-id")
        : undefined) ??
      findByAttribute("data-message-id") ??
      (recordedTarget?.isConnected === true ? recordedTarget : undefined)
    )?.focus();
    detailReturnFocusRef.current = undefined;
    detailReturnFocusMessageIdRef.current = undefined;
    detailReturnFocusOriginRef.current = undefined;
  }, []);
  const { conversationsState, loadMoreConversations } = useConversationPages({
    backupId: record.id,
    getDbClient,
    pageSize: conversationPageSize,
  });

  useEffect(() => {
    timelineStateRef.current = timelineState;
  }, [timelineState]);

  useEffect(() => {
    searchResultsStateRef.current = searchResultsState;
  }, [searchResultsState]);

  useEffect(() => {
    // React StrictMode probes setup/cleanup/setup with the same refs in dev.
    routeActiveRef.current = true;

    return () => {
      routeActiveRef.current = false;
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
    };
  }, []);

  useEffect(() => {
    if (activeSearch === undefined || isSubmittingSearch) {
      resultsRequestKeyRef.current = "";
      return;
    }

    const requestKey = buildResultsScopeKey(
      activeSearch.token,
      selectedConversationId,
    );
    const pendingScopeClear = pendingScopeClearRef.current;

    if (pendingScopeClear !== undefined) {
      if (
        pendingScopeClear.token === activeSearch.token &&
        selectedConversationId === pendingScopeClear.conversationId
      ) {
        // The replacement search already displayed all-scope results; the
        // URL cleanup deleting this conversation selection is still
        // committing through the router transition. Skip the transient
        // stale-scope fetch it would otherwise trigger.
        return;
      }

      pendingScopeClearRef.current = undefined;
    }

    if (displayedResultsKeyRef.current === requestKey) {
      resultsRequestKeyRef.current = requestKey;
      const displayedResponse = getSearchResponse(
        searchResultsStateRef.current,
      );

      if (
        displayedResponse !== undefined &&
        searchResultsStateRef.current.kind !== "ready"
      ) {
        const nextState: SearchResultsState = {
          kind: "ready",
          loadingMore: false,
          response: displayedResponse,
        };

        searchResultsStateRef.current = nextState;
        setSearchResultsState(nextState);
      }
      return;
    }

    const active = { current: true };
    const client = getDbClient();
    const previousResponse = getSearchResponse(
      searchResultsStateRef.current,
    );

    resultsRequestKeyRef.current = requestKey;
    setSearchResultsState({ kind: "loading", response: previousResponse });
    void (async () => {
      try {
        const result = await client.api.searchMessages({
          backupId: record.id,
          filters: {
            ...activeSearch.filters,
            ...(selectedConversationId === undefined
              ? {}
              : { conversationId: selectedConversationId }),
          },
          limit: searchPageSize,
          text: activeSearch.text,
        });

        if (!active.current || resultsRequestKeyRef.current !== requestKey) {
          return;
        }

        if (!result.ok) {
          setSearchResultsState({
            kind: "error",
            message: formatWorkerResultError(result.error),
            response: previousResponse,
          });
          return;
        }

        displayedResultsKeyRef.current = requestKey;
        displayedResultsScopeConversationIdRef.current = selectedConversationId;
        const nextState: SearchResultsState = {
          kind: "ready",
          loadingMore: false,
          response: result.value,
        };

        searchResultsStateRef.current = nextState;
        setSearchResultsState(nextState);
      } catch (cause) {
        if (active.current && resultsRequestKeyRef.current === requestKey) {
          setSearchResultsState({
            kind: "error",
            message: formatError(cause),
            response: previousResponse,
          });
        }
      }
    })();

    return () => {
      active.current = false;
    };
  }, [
    activeSearch,
    getDbClient,
    isSubmittingSearch,
    record.id,
    scopeRequestVersion,
    selectedConversationId,
  ]);

  useEffect(() => {
    // The fourth pane docks only when all columns physically fit. The
    // --layout-detail-dock token resolved by detailDockMediaQuery is the
    // single source of truth: this state drives the dialog/overlay semantics
    // AND the grid-template-columns classes below (CSS media queries cannot
    // reference custom properties, so no stylesheet breakpoint is involved).
    const media = detailDockMediaQuery();
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
    if (activeSearch !== undefined) {
      return;
    }

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
  }, [activeSearch, conversationsState, selectedConversationId, setSearchParams]);

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

  const detailOpen = selectedMessageId !== undefined;
  const detailOverlayOpen = detailOverlayActive && detailOpen;
  useEffect(() => {
    detailOverlayOpenRef.current = detailOverlayOpen;
  }, [detailOverlayOpen]);

  useEffect(() => {
    // Deep links and keyboard flows can open the overlay without going
    // through selectMessage; remember where focus was so Close can return
    // it. Declared before the containment hook below so it reads the
    // activeElement before the dialog steals focus.
    if (!detailOverlayOpen) {
      return;
    }

    const previous = document.activeElement;

    if (
      detailReturnFocusRef.current === undefined &&
      previous instanceof HTMLElement
    ) {
      detailReturnFocusRef.current = previous;
    }
  }, [detailOverlayOpen]);

  useEffect(() => {
    // Return focus to the activating element only when the details close
    // entirely — crossing the dock threshold keeps them open (in the other
    // mode) and must not yank focus back or clear the return-target refs.
    if (detailOpen) {
      wasDetailOpenRef.current = true;
      return;
    }

    if (!wasDetailOpenRef.current) {
      return;
    }

    wasDetailOpenRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      if (focusUnlockAfterDetailCloseRef.current) {
        focusUnlockAfterDetailCloseRef.current = false;
        detailReturnFocusRef.current = undefined;
        detailReturnFocusMessageIdRef.current = undefined;
        detailReturnFocusOriginRef.current = undefined;
        encryptedPasswordForm.focus();
        return;
      }

      focusDetailReturnTarget();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [detailOpen, encryptedPasswordForm, focusDetailReturnTarget]);

  useEffect(() => {
    if (!detailOpen) {
      previousDetailModeRef.current = undefined;
      return;
    }

    const mode = detailOverlayActive ? "overlay" : "docked";
    const previousMode = previousDetailModeRef.current;

    previousDetailModeRef.current = mode;

    if (previousMode !== undefined && previousMode !== mode && mode === "docked") {
      // The overlay pane unmounted with focus inside it while details stay
      // open; land focus on the docked pane instead of dropping it on
      // <body>. (The docked -> overlay direction is focused by the modal
      // containment hook.)
      detailPaneRef.current?.focus();
    }
  }, [detailOpen, detailOverlayActive]);

  const selectedConversation =
    timelineState.kind === "ready" ? timelineState.page.conversation : undefined;
  const displayedSearchThreads = getSearchResponse(searchThreadsState);
  const displayedSearchResults = getSearchResponse(searchResultsState);
  const effectivePinnedSearchResult = selectScopedCachedSearchResult(
    activatedSearchResults,
    selectedMessageId,
    selectedConversationId,
  );
  const pinnedSearchConversation = effectivePinnedSearchResult?.conversation;
  const selectedSearchConversation =
    displayedSearchThreads?.conversations.find(
      (conversation) => conversation.id === selectedConversationId,
    ) ??
    (pinnedSearchConversation?.id === selectedConversationId
      ? pinnedSearchConversation
      : undefined) ??
    (timelineState.kind === "ready" &&
    timelineState.page.conversation.id === selectedConversationId
      ? timelineState.page.conversation
      : undefined);
  const currentSearchResultsKey =
    activeSearch === undefined
      ? ""
      : buildResultsScopeKey(activeSearch.token, selectedConversationId);
  const canJumpSearchResults =
    searchResultsState.kind === "ready" &&
    displayedResultsKeyRef.current === currentSearchResultsKey;
  const canJumpTimeline =
    timelineState.kind === "ready" &&
    timelineState.page.conversation.id === selectedConversationId;
  const displayedResultsScopeConversationId =
    displayedResultsScopeConversationIdRef.current;
  const displayedResultsScopeConversation =
    displayedResultsScopeConversationId === undefined
      ? undefined
      : displayedSearchThreads?.conversations.find(
          (conversation) =>
            conversation.id === displayedResultsScopeConversationId,
        ) ??
        Array.from(activatedSearchResults.values()).find(
          (result) =>
            result.conversation.id === displayedResultsScopeConversationId,
        )?.conversation ??
        (timelineState.kind === "ready" &&
        timelineState.page.conversation.id ===
          displayedResultsScopeConversationId
          ? timelineState.page.conversation
          : undefined);
  const isDisplayingPreviousSearchScope =
    displayedSearchResults !== undefined &&
    displayedResultsKeyRef.current !== currentSearchResultsKey;
  const searchResultsPaneBaseTitle =
    displayedSearchResults === undefined
      ? selectedSearchConversation === undefined
        ? "Results"
        : "Results: " + conversationTitle(selectedSearchConversation)
      : displayedResultsScopeConversationId === undefined
        ? "Results"
        : displayedResultsScopeConversation === undefined
          ? "Results: Selected thread"
          : "Results: " + conversationTitle(displayedResultsScopeConversation);
  const searchResultsPaneTitle =
    searchResultsPaneBaseTitle +
    (isDisplayingPreviousSearchScope ? " (previous scope)" : "");
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
  const showAllSearchResults = useCallback(() => {
    // Deliberately pushes a history entry (no replace): "All" is a user
    // navigation, so Back returns to the previously scoped thread.
    setSearchParams(clearSelectionSearchParams);
  }, [setSearchParams]);
  const selectMessage = useCallback(
    (
      messageId: string,
      conversationId: string,
      origin: DetailReturnOrigin = "message",
    ) => {
      const activeElement = document.activeElement;

      detailReturnFocusRef.current =
        activeElement instanceof HTMLElement ? activeElement : undefined;
      detailReturnFocusMessageIdRef.current = messageId;
      detailReturnFocusOriginRef.current = origin;
      setSearchParams((current) => {
        const next = new URLSearchParams(current);

        next.set("conversation", conversationId);
        next.set("message", messageId);

        return next;
      });
    },
    [setSearchParams],
  );
  const selectSearchResult = useCallback(
    (result: SearchMessageResult) => {
      setActivatedSearchResults((current) => {
        const next = new Map(current);

        next.set(result.message.id, result);

        return next;
      });
      setSearchResultActivationRevision((current) => current + 1);
      selectMessage(
        result.message.id,
        result.message.conversationId,
        "search-result",
      );
    },
    [selectMessage],
  );
  const closeDetail = useCallback(() => {
    // Focus return is handled by the detail-close effect above, which also
    // covers Escape, browser Back, and every other way ?message can clear.
    setSearchParams((current) => {
      const next = new URLSearchParams(current);

      next.delete("message");

      return next;
    });
  }, [setSearchParams]);
  const focusEncryptedUnlock = useCallback(() => {
    if (!isRouteActive(routeActiveRef)) {
      return;
    }

    if (detailOverlayOpenRef.current) {
      focusUnlockAfterDetailCloseRef.current = true;
      closeDetail();
      return;
    }

    encryptedPasswordForm.focus();
  }, [closeDetail, encryptedPasswordForm]);
  const requireEncryptedUnlock = useCallback(() => {
    if (!isRouteActive(routeActiveRef)) {
      return;
    }

    setEncryptedSessionState({ kind: "locked" });
    // The success strip must first re-render as the shared password form.
    // If Details is modal, focusEncryptedUnlock then closes it before focus.
    requestAnimationFrame(focusEncryptedUnlock);
  }, [focusEncryptedUnlock]);
  // The context identity must change only when the derived fields change.
  // Memoizing on the whole state object would mint a new identity for every
  // unlock progress label, and each new identity cancels and re-issues every
  // mounted attachment preview (loadPreview and the preview effects depend on
  // this context). The changing label is rendered by the unlock form directly
  // from the state and deliberately stays out of the context.
  const isEncryptedSessionUnlocked = encryptedSessionState.kind === "unlocked";
  const encryptedSessionRevision =
    encryptedSessionState.kind === "unlocked"
      ? encryptedSessionState.revision
      : 0;
  const encryptedSessionContext = useMemo<EncryptedSessionContextValue>(
    () => ({
      focusUnlock: focusEncryptedUnlock,
      isEncrypted: record.isEncrypted,
      isUnlocked: isEncryptedSessionUnlocked,
      requireUnlock: requireEncryptedUnlock,
      revision: encryptedSessionRevision,
    }),
    [
      encryptedSessionRevision,
      focusEncryptedUnlock,
      isEncryptedSessionUnlocked,
      record.isEncrypted,
      requireEncryptedUnlock,
    ],
  );

  useModalFocusContainment({
    active: detailOverlayOpen,
    containerRef: detailPaneRef,
    onDismiss: closeDetail,
  });
  const submitSearch = useCallback(
    (draft: SearchDraft) => {
      const text = draft.query.trim();

      if (text.length === 0 || isSubmittingSearch) {
        return;
      }

      const token = searchTokenRef.current + 1;
      const filters = buildSearchFilters(draft);
      const pendingSearch: ActiveSearch = { filters, text, token };
      const previousToken = activeSearch?.token ?? searchTokenRef.current;
      const previousThreadsResponse = getSearchResponse(searchThreadsState);
      const previousResultsResponse = getSearchResponse(searchResultsState);
      const stableThreadsState: SearchThreadsState =
        previousThreadsResponse === undefined
          ? searchThreadsState
          : {
              kind: "ready",
              loadingMore: false,
              response: previousThreadsResponse,
            };
      const stableResultsState: SearchResultsState =
        previousResultsResponse === undefined
          ? searchResultsState
          : {
              kind: "ready",
              loadingMore: false,
              response: previousResultsResponse,
            };
      const restorePreviousSearch = (message: string) => {
        searchTokenRef.current = previousToken;
        resultsRequestKeyRef.current = displayedResultsKeyRef.current;
        pendingScopeClearRef.current = undefined;
        searchResultsStateRef.current = stableResultsState;
        setSearchThreadsState(stableThreadsState);
        setSearchResultsState(stableResultsState);
        setSearchSubmissionError(message);
        setIsSubmittingSearch(false);
        setScopeRequestVersion((current) => current + 1);
      };

      searchTokenRef.current = token;
      resultsRequestKeyRef.current = buildReplacementResultsKey(token);
      setSearchSubmissionError(undefined);
      setIsSubmittingSearch(true);
      searchResultsStateRef.current = stableResultsState;
      setSearchThreadsState(stableThreadsState);
      setSearchResultsState(stableResultsState);

      void (async () => {
        try {
          const [threadsResult, resultsResult] = await Promise.all([
            getDbClient().api.listSearchConversations({
              backupId: record.id,
              filters,
              limit: searchPageSize,
              text,
            }),
            getDbClient().api.searchMessages({
              backupId: record.id,
              filters,
              limit: searchPageSize,
              text,
            }),
          ]);

          if (searchTokenRef.current !== token) {
            return;
          }

          if (!threadsResult.ok || !resultsResult.ok) {
            const message = !threadsResult.ok
              ? formatWorkerResultError(threadsResult.error)
              : !resultsResult.ok
                ? formatWorkerResultError(resultsResult.error)
                : "The search could not be completed.";

            restorePreviousSearch(message);
            return;
          }

          const resultsKey = buildResultsScopeKey(token, undefined);
          const nextResultsState: SearchResultsState = {
            kind: "ready",
            loadingMore: false,
            response: resultsResult.value,
          };

          resultsRequestKeyRef.current = resultsKey;
          displayedResultsKeyRef.current = resultsKey;
          displayedResultsScopeConversationIdRef.current = undefined;
          // The conversation param below is deleted inside a router
          // transition that commits after this batch of state updates; mark
          // the old selection so the scoped-results effect ignores the
          // intermediate render instead of fetching a stale scope.
          pendingScopeClearRef.current =
            selectedConversationId === undefined
              ? undefined
              : { conversationId: selectedConversationId, token };
          searchResultsStateRef.current = nextResultsState;
          setActivatedSearchResults(new Map());
          setSearchThreadsState({
            kind: "ready",
            loadingMore: false,
            response: threadsResult.value,
          });
          setSearchResultsState(nextResultsState);
          setActiveSearch(pendingSearch);
          setSearchSubmissionError(undefined);
          setSearchParams(clearSelectionSearchParams, { replace: true });
        } catch (cause) {
          if (searchTokenRef.current === token) {
            restorePreviousSearch(formatError(cause));
          }
        } finally {
          if (searchTokenRef.current === token) {
            setIsSubmittingSearch(false);
          }
        }
      })();
    },
    [
      getDbClient,
      isSubmittingSearch,
      activeSearch,
      record.id,
      searchResultsState,
      searchThreadsState,
      selectedConversationId,
      setSearchParams,
    ],
  );
  const resetSearch = useCallback(() => {
    searchTokenRef.current += 1;
    resultsRequestKeyRef.current = "";
    displayedResultsKeyRef.current = "";
    displayedResultsScopeConversationIdRef.current = undefined;
    pendingScopeClearRef.current = undefined;
    searchResultsStateRef.current = { kind: "idle" };
    setIsSubmittingSearch(false);
    setSearchSubmissionError(undefined);
    setActiveSearch(undefined);
    setActivatedSearchResults(new Map());
    setSearchThreadsState({ kind: "idle" });
    setSearchResultsState({ kind: "idle" });
    setSearchParams(clearSelectionSearchParams, { replace: true });
  }, [setSearchParams]);
  const loadMoreSearchThreads = useCallback(async () => {
    if (activeSearch === undefined) {
      return;
    }

    // A replacement search bumps the token, so pages from the previous
    // search are discarded rather than merged into the new response.
    const requestedToken = activeSearch.token;

    await loadMoreSearchPage({
      fetchPage: (offset) =>
        getDbClient().api.listSearchConversations({
          backupId: record.id,
          filters: activeSearch.filters,
          limit: searchPageSize,
          offset,
          text: activeSearch.text,
        }),
      getItemCount: (response) => response.conversations.length,
      getTotal: (response) => response.total,
      isStale: () => searchTokenRef.current !== requestedToken,
      mergeResponses: (current, next) => ({
        ...next,
        conversations: mergeById(current.conversations, next.conversations),
        offset: 0,
      }),
      setState: setSearchThreadsState,
      state: searchThreadsState,
    });
  }, [activeSearch, getDbClient, record.id, searchThreadsState]);
  const loadMoreSearchResults = useCallback(async () => {
    if (activeSearch === undefined) {
      return;
    }

    // Results are additionally scoped by the selected conversation, so the
    // staleness guard is the scope request key, not just the search token.
    const requestKey = resultsRequestKeyRef.current;

    await loadMoreSearchPage({
      fetchPage: (offset) =>
        getDbClient().api.searchMessages({
          backupId: record.id,
          filters: {
            ...activeSearch.filters,
            ...(selectedConversationId === undefined
              ? {}
              : { conversationId: selectedConversationId }),
          },
          limit: searchPageSize,
          offset,
          text: activeSearch.text,
        }),
      getItemCount: (response) => response.results.length,
      getTotal: (response) => response.total,
      isStale: () => resultsRequestKeyRef.current !== requestKey,
      mergeResponses: (current, next) => ({
        ...next,
        offset: 0,
        results: mergeBy(
          current.results,
          next.results,
          (item) => item.message.id,
        ),
      }),
      setState: setSearchResultsState,
      state: searchResultsState,
    });
  }, [
    activeSearch,
    getDbClient,
    record.id,
    searchResultsState,
    selectedConversationId,
  ]);
  const retryResultsScope = useCallback(() => {
    setScopeRequestVersion((current) => current + 1);
  }, []);
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
    <EncryptedSessionContext.Provider value={encryptedSessionContext}>
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
          {record.isEncrypted ? <Badge variant="warning">Encrypted</Badge> : null}
        </>
      }
      description="Browse or search conversations, inspect message metadata, and preview source attachments without modifying the backup."
      eyebrow="Messages"
      maxWidth="full"
      title={record.friendlyName}
    >
      <SearchPanel
        activeSearch={activeSearch}
        isSubmittingSearch={isSubmittingSearch}
        searchResultsState={searchResultsState}
        submissionError={searchSubmissionError}
        searchThreadsState={searchThreadsState}
        onReset={resetSearch}
        onSubmit={submitSearch}
      />

      {record.isEncrypted ? (
        <EncryptedAttachmentUnlock
          controller={encryptedPasswordForm}
          onLock={lockEncryptedSession}
          state={encryptedSessionState}
          onUnlock={unlockEncryptedSession}
        />
      ) : null}

      <div
        aria-busy={isSubmittingSearch}
        className={cn(
          "relative grid min-h-[var(--layout-workspace-min)] flex-1 overflow-hidden rounded-lg border border-border bg-surface shadow-1",
          activeSearch === undefined
            ? "[grid-template-columns:var(--pane-threads)_minmax(var(--pane-timeline-min),1fr)]"
            : "[grid-template-columns:var(--pane-search-threads)_var(--pane-results)_minmax(var(--pane-search-timeline-min),1fr)]",
          // The docked fourth column follows the same --layout-detail-dock
          // matchMedia state as the dialog semantics (detailDockMediaQuery)
          // — not a stylesheet breakpoint, which could not track the
          // rem-based token.
          detailOpen &&
            !detailOverlayActive &&
            (activeSearch === undefined
              ? "[grid-template-columns:var(--pane-threads)_minmax(var(--pane-timeline-min),1fr)_var(--pane-detail)]"
              : "[grid-template-columns:var(--pane-search-threads)_var(--pane-results)_minmax(var(--pane-search-timeline-min),1fr)_var(--pane-detail)]"),
        )}
        data-testid="messages-workspace"
        inert={isSubmittingSearch}
      >
        <MessagesPane testId="threads-pane" title="Threads">
          {activeSearch === undefined ? (
            <ConversationPane
              conversationsState={conversationsState}
              selectedConversationId={selectedConversationId}
              onLoadMoreConversations={() => {
                void loadMoreConversations();
              }}
              onSelectConversation={selectConversation}
            />
          ) : (
            <SearchConversationPane
              selectedConversationId={selectedConversationId}
              state={searchThreadsState}
              onLoadMore={() => {
                void loadMoreSearchThreads();
              }}
              onSelectConversation={selectConversation}
            />
          )}
        </MessagesPane>

        {activeSearch === undefined ? null : (
          <MessagesPane
            actions={
              <div className="flex items-center gap-2">
                {displayedSearchResults === undefined ? null : (
                  <Badge variant="neutral">
                    {displayedSearchResults.total.toLocaleString()}
                  </Badge>
                )}
                <Button
                  aria-label="Show results from all threads"
                  disabled={selectedConversationId === undefined}
                  onClick={showAllSearchResults}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  All
                </Button>
              </div>
            }
            className="border-l border-border"
            testId="search-results-pane"
            title={searchResultsPaneTitle}
          >
            <SearchResultsPane
              activationRevision={searchResultActivationRevision}
              canHandleJump={canJumpSearchResults}
              isDisplayingPreviousScope={isDisplayingPreviousSearchScope}
              jumpMessageId={effectivePinnedSearchResult?.message.id}
              pinnedResult={effectivePinnedSearchResult}
              selectedMessageId={selectedMessageId}
              state={searchResultsState}
              onLoadMore={() => {
                void loadMoreSearchResults();
              }}
              onRetry={retryResultsScope}
              onSelectResult={selectSearchResult}
            />
          </MessagesPane>
        )}

        <MessagesPane
          className="border-l border-border"
          testId="timeline-pane"
          title={selectedConversation === undefined ? "Timeline" : conversationTitle(selectedConversation)}
        >
          <TimelinePane
            activationRevision={searchResultActivationRevision}
            canHandleJump={canJumpTimeline}
            getBackupClient={getBackupClient}
            getMediaClient={getMediaClient}
            jumpMessageId={effectivePinnedSearchResult?.message.id}
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

          {selectedMessageId === undefined || detailOverlayOpen ? null : (
            <MessageDetailsPane
              detailState={detailState}
              getBackupClient={getBackupClient}
              getMediaClient={getMediaClient}
              isOverlay={false}
              paneRef={detailPaneRef}
              record={record}
              runPreviewTask={runPreviewTask}
              onDismiss={closeDetail}
            />
          )}
        </div>
      </PageShell>

      {selectedMessageId === undefined || !detailOverlayOpen
        ? null
        : createPortal(
            <div
              className="fixed inset-0 z-50 flex justify-end bg-[var(--overlay-scrim)]"
              data-testid="message-details-overlay"
            >
              <MessageDetailsPane
                detailState={detailState}
                getBackupClient={getBackupClient}
                getMediaClient={getMediaClient}
                isOverlay
                paneRef={detailPaneRef}
                record={record}
                runPreviewTask={runPreviewTask}
                onDismiss={closeDetail}
              />
            </div>,
            document.body,
          )}
    </EncryptedSessionContext.Provider>
  );
}

function EncryptedAttachmentUnlock({
  controller,
  onLock,
  onUnlock,
  state,
}: {
  controller: BackupPasswordFormController;
  onLock: () => Promise<void>;
  onUnlock: () => Promise<void>;
  state: EncryptedSessionState;
}) {
  if (state.kind === "unlocked") {
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-md border border-success bg-[var(--success-subtle)] px-3 py-2 text-caption text-[var(--success-foreground)]"
        role="status"
      >
        <LockKeyhole aria-hidden="true" className="size-4" />
        <span className="min-w-0 flex-1">
          Source attachments are unlocked for this worker session. Keys are not stored;
          generated previews remain local until the backup is removed.
        </span>
        <Button
          onClick={() => {
            void onLock();
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Lock attachments
        </Button>
      </div>
    );
  }

  const isBusy = state.kind === "unlocking" || state.kind === "locking";

  return (
    <BackupPasswordForm
      actions={
        <Button disabled={isBusy} size="sm" type="submit" variant="secondary">
          {state.kind === "locking"
            ? "Locking attachments"
            : state.kind === "unlocking"
              ? "Unlocking attachments"
              : "Unlock attachments"}
        </Button>
      }
      className="rounded-md border border-border bg-surface px-4 py-3 shadow-1"
      controller={controller}
      disabled={isBusy}
      disclosureLeadIn="Searchable messages are already in the local derived database. Unlock the source backup to preview or extract original attachments."
      errorDescriptionId="encrypted-unlock-error"
      inputId="messages-backup-password"
      inputSize="md"
      invalid={state.kind === "error"}
      layout="inline"
      leading={
        <LockKeyhole aria-hidden="true" className="mb-2 size-5 text-text-tertiary" />
      }
      onSubmit={() => {
        void onUnlock();
      }}
      required
    >
      {state.kind === "unlocking" || state.kind === "locking" ? (
        <p className="mt-2 text-caption text-[var(--info-foreground)]" role="status">
          {state.label}
        </p>
      ) : state.kind === "error" ? (
        <p
          className="mt-2 flex items-start gap-2 text-caption text-danger"
          id="encrypted-unlock-error"
          role="alert"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{state.message}</span>
        </p>
      ) : null}
    </BackupPasswordForm>
  );
}

function MessageDetailsPane({
  detailState,
  getBackupClient,
  getMediaClient,
  isOverlay,
  onDismiss,
  paneRef,
  record,
  runPreviewTask,
}: {
  detailState: DetailState;
  getBackupClient: () => BackupWorkerClient;
  getMediaClient: () => MediaWorkerClient;
  isOverlay: boolean;
  onDismiss: () => void;
  paneRef: Ref<HTMLElement>;
  record: RecentBackupRecord;
  runPreviewTask: RunPreviewTask;
}) {
  return (
    <MessagesPane
      actions={
        <Button
          aria-label="Close message details"
          onClick={onDismiss}
          size="sm"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" className="size-4" />
          Close
        </Button>
      }
      className={cn(
        "border-l border-border",
        isOverlay &&
          "ml-auto w-[min(var(--pane-detail),calc(100%_-_var(--space-16)))] shadow-3",
      )}
      dialog={isOverlay ? { label: "Message details" } : undefined}
      paneRef={paneRef}
      testId="message-details-pane"
      title="Details"
    >
      <DetailPane
        getBackupClient={getBackupClient}
        getMediaClient={getMediaClient}
        record={record}
        runPreviewTask={runPreviewTask}
        state={detailState}
      />
    </MessagesPane>
  );
}

function SearchPanel({
  activeSearch,
  isSubmittingSearch,
  onReset,
  onSubmit,
  searchResultsState,
  searchThreadsState,
  submissionError,
}: {
  activeSearch: ActiveSearch | undefined;
  isSubmittingSearch: boolean;
  onReset: () => void;
  onSubmit: (draft: SearchDraft) => void;
  searchResultsState: SearchResultsState;
  searchThreadsState: SearchThreadsState;
  submissionError: string | undefined;
}) {
  // Draft fields live here — not in the workspace — so keystrokes re-render
  // only this panel, never the virtualized panes. Values lift on submit.
  const [query, setQuery] = useState("");
  const [participantQuery, setParticipantQuery] = useState("");
  const [hasAttachment, setHasAttachment] = useState(false);
  const [dateRange, setDateRange] = useState<DateRangeValue>({ from: "", to: "" });
  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit({
      fromDate: dateRange.from,
      hasAttachment,
      participantQuery,
      query,
      toDate: dateRange.to,
    });
  };
  const handleReset = () => {
    setQuery("");
    setParticipantQuery("");
    setHasAttachment(false);
    setDateRange({ from: "", to: "" });
    onReset();
  };
  const isStartingSearch =
    isSubmittingSearch || searchThreadsState.kind === "loading";
  const isSearching =
    isStartingSearch ||
    (activeSearch !== undefined && searchResultsState.kind === "loading");
  const initialSearchError =
    activeSearch === undefined
      ? searchThreadsState.kind === "error"
        ? searchThreadsState.message
        : searchResultsState.kind === "error"
          ? searchResultsState.message
          : undefined
      : undefined;

  return (
    <section
      aria-label="Message search filters"
      className="rounded-lg border border-border bg-surface p-4 shadow-1"
      data-testid="m4-search-panel"
    >
      <form
        className="grid gap-4"
        data-testid="m4-search-form"
        onSubmit={handleSubmit}
      >
        <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-end">
          <label className="min-w-0 flex-1">
            <span className="text-caption text-text-secondary">Search messages</span>
            <input
              className="mt-1 h-[var(--control-height-lg)] w-full rounded-md border border-border-strong bg-surface-sunken px-3 text-body text-text placeholder:text-text-tertiary"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Enter words or a quoted string"
              required
              type="search"
              value={query}
            />
          </label>
          <Button
            disabled={isStartingSearch || query.trim().length === 0}
            size="lg"
            type="submit"
            variant="primary"
          >
            <Search aria-hidden="true" className="size-4" />
            {isStartingSearch ? "Searching..." : "Search"}
          </Button>
          <Button
            disabled={
              activeSearch === undefined &&
              query.length === 0 &&
              participantQuery.length === 0 &&
              dateRange.from.length === 0 &&
              dateRange.to.length === 0 &&
              !hasAttachment
            }
            onClick={handleReset}
            size="lg"
            type="button"
            variant="secondary"
          >
            Reset
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
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
          <DateRangePicker onChange={setDateRange} value={dateRange} />
          <label className="flex min-h-[var(--control-height-lg)] items-center gap-2 self-end text-body text-text">
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

      <div aria-live="polite" className="mt-3 flex items-center gap-2 text-caption text-text-secondary">
        {activeSearch === undefined ? (
          <span>
            {isStartingSearch
              ? "Searching all extracted conversations."
              : "Search spans all extracted conversations."}
          </span>
        ) : (
          <>
            <Badge variant="accent">Search active</Badge>
            <span className="min-w-0 truncate">
              {isSubmittingSearch
                ? `Searching for “${query.trim()}”`
                : `${isSearching ? "Searching" : "Showing results"} for “${activeSearch.text}”`}
            </span>
          </>
        )}
      </div>
      {initialSearchError === undefined ? null : (
        <div className="mt-3">
          <InlineNotice kind="danger">{initialSearchError}</InlineNotice>
        </div>
      )}
      {submissionError === undefined ? null : (
        <div className="mt-3">
          <InlineNotice kind="danger">{submissionError}</InlineNotice>
        </div>
      )}
    </section>
  );
}

function SearchConversationPane({
  onLoadMore,
  onSelectConversation,
  selectedConversationId,
  state,
}: {
  onLoadMore: () => void;
  onSelectConversation: (conversationId: string) => void;
  selectedConversationId: string | undefined;
  state: SearchThreadsState;
}) {
  const response = getSearchResponse(state);

  if (state.kind === "idle" || (state.kind === "loading" && response === undefined)) {
    return (
      <PaneEmpty icon={<Loader2 aria-hidden="true" className="size-6" />}>
        Finding conversations with matches.
      </PaneEmpty>
    );
  }

  if (state.kind === "error" && response === undefined) {
    return (
      <div className="p-4">
        <InlineNotice kind="danger">{state.message}</InlineNotice>
      </div>
    );
  }

  if (response === undefined) {
    return null;
  }

  return (
    <div className="flex h-full flex-col" data-testid="search-thread-list">
      {state.kind === "loading" ? (
        <div className="border-b border-border p-3">
          <InlineNotice>Finding conversations. Previous matches remain visible.</InlineNotice>
        </div>
      ) : state.kind === "error" ? (
        <div className="border-b border-border p-3">
          <InlineNotice kind="danger">{state.message}</InlineNotice>
        </div>
      ) : null}
      {response.coverage.truncated ? (
        <div className="border-b border-border p-3">
          <CoverageWarning coverage={response.coverage} />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {response.conversations.length === 0 ? (
          <PaneEmpty icon={<MessageSquareText aria-hidden="true" className="size-6" />}>
            {state.kind === "loading"
              ? "The previous search had no matching conversations. Finding new matches."
              : state.kind === "error"
                ? "The previous search had no matching conversations."
                : "No conversations matched this search."}
          </PaneEmpty>
        ) : (
          <Virtuoso
            className="h-full"
            data={response.conversations}
            itemContent={(_, conversation) => (
              <SearchConversationRow
                conversation={conversation}
                isSelected={conversation.id === selectedConversationId}
                onSelect={() => {
                  onSelectConversation(conversation.id);
                }}
              />
            )}
          />
        )}
      </div>
      {state.kind !== "ready" || state.moreError === undefined ? null : (
        <div className="border-t border-border p-3">
          <InlineNotice kind="danger">{state.moreError}</InlineNotice>
        </div>
      )}
      {state.kind === "ready" && response.conversations.length < response.total ? (
        <div className="border-t border-border p-3">
          <Button
            className="w-full"
            disabled={state.loadingMore}
            onClick={onLoadMore}
            size="sm"
            type="button"
            variant="secondary"
          >
            {state.loadingMore ? "Loading..." : "Load more threads"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SearchConversationRow({
  conversation,
  isSelected,
  onSelect,
}: {
  conversation: DbSearchConversationSummary;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-current={isSelected ? "true" : undefined}
      className={cn(listRowClass, isSelected && listRowSelectedClass)}
      data-testid={`conversation-${conversation.id}`}
      onClick={onSelect}
      type="button"
    >
      <span className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 truncate text-body font-[var(--font-weight-strong)] text-text">
          {conversationTitle(conversation)}
        </span>
        <Badge
          aria-label={`${conversation.hitCount.toLocaleString()} search ${
            conversation.hitCount === 1 ? "hit" : "hits"
          }`}
          data-testid={`search-hit-count-${conversation.id}`}
          variant="neutral"
        >
          {conversation.hitCount.toLocaleString()}
        </Badge>
      </span>
      <span className="mt-2 block text-micro text-text-tertiary">
        Latest match {formatDateTime(conversation.latestHitAtUtc)}
      </span>
    </button>
  );
}

function SearchResultsPane({
  activationRevision,
  canHandleJump,
  isDisplayingPreviousScope,
  jumpMessageId,
  onLoadMore,
  onRetry,
  onSelectResult,
  pinnedResult,
  selectedMessageId,
  state,
}: {
  activationRevision: number;
  canHandleJump: boolean;
  isDisplayingPreviousScope: boolean;
  jumpMessageId: string | undefined;
  onLoadMore: () => void;
  onRetry: () => void;
  onSelectResult: (result: SearchMessageResult) => void;
  pinnedResult: SearchMessageResult | undefined;
  selectedMessageId: string | undefined;
  state: SearchResultsState;
}) {
  const response = getSearchResponse(state);
  const displayedResults = useMemo(
    () => includePinnedSearchResult(response?.results ?? [], pinnedResult),
    [pinnedResult, response?.results],
  );
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const findResultIndex = useCallback(
    (messageId: string) =>
      displayedResults.findIndex((result) => result.message.id === messageId),
    [displayedResults],
  );

  useVirtuosoJump({
    activationRevision,
    canHandleJump,
    findIndex: findResultIndex,
    jumpMessageId,
    virtuosoRef,
  });

  if (state.kind === "idle" || (state.kind === "loading" && response === undefined)) {
    return (
      <PaneEmpty icon={<Loader2 aria-hidden="true" className="size-6" />}>
        Searching messages.
      </PaneEmpty>
    );
  }

  if (state.kind === "error" && response === undefined) {
    return (
      <div className="grid gap-3 p-4">
        <InlineNotice kind="danger">{state.message}</InlineNotice>
        <Button onClick={onRetry} size="sm" type="button" variant="secondary">
          Retry search
        </Button>
      </div>
    );
  }

  if (response === undefined) {
    return null;
  }

  return (
    <div className="flex h-full flex-col" data-testid="m4-search-results">
      {state.kind === "loading" ? (
        <div className="border-b border-border p-3">
          <InlineNotice>
            Searching messages. Previous-scope results remain visible.
          </InlineNotice>
        </div>
      ) : state.kind === "error" ? (
        <div className="grid gap-2 border-b border-border p-3">
          <InlineNotice kind="danger">
            {state.message}
            {isDisplayingPreviousScope
              ? " Showing previous-scope results."
              : ""}
          </InlineNotice>
          <Button
            onClick={onRetry}
            size="sm"
            type="button"
            variant="secondary"
          >
            Retry search
          </Button>
        </div>
      ) : null}
      {response.coverage.truncated ? (
        <div className="border-b border-border p-3">
          <CoverageWarning coverage={response.coverage} />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {displayedResults.length === 0 ? (
          <PaneEmpty icon={<MessageSquareText aria-hidden="true" className="size-6" />}>
            {state.kind === "loading"
              ? "The previous search scope had no matching messages. Searching again."
              : state.kind === "error"
                ? "The previous search scope had no matching messages."
                : "No messages matched this search scope."}
          </PaneEmpty>
        ) : (
          <Virtuoso
            className="h-full"
            data={displayedResults}
            itemContent={(_, result) => (
              <SearchResultRow
                isSelected={result.message.id === selectedMessageId}
                result={result}
                onSelect={() => {
                  onSelectResult(result);
                }}
              />
            )}
            ref={virtuosoRef}
          />
        )}
      </div>
      {state.kind !== "ready" || state.moreError === undefined ? null : (
        <div className="border-t border-border p-3">
          <InlineNotice kind="danger">{state.moreError}</InlineNotice>
        </div>
      )}
      {state.kind === "ready" && response.results.length < response.total ? (
        <div className="border-t border-border p-3">
          <Button
            className="w-full"
            disabled={state.loadingMore || isDisplayingPreviousScope}
            onClick={onLoadMore}
            size="sm"
            type="button"
            variant="secondary"
          >
            {state.loadingMore ? "Loading..." : "Load more results"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SearchResultRow({
  isSelected,
  onSelect,
  result,
}: {
  isSelected: boolean;
  onSelect: () => void;
  result: SearchMessageResult;
}) {
  const sender =
    result.message.sender === undefined
      ? result.message.isFromMe
        ? "Me"
        : "Unknown sender"
      : participantLabel(result.message.sender);

  return (
    <button
      aria-current={isSelected ? "true" : undefined}
      className={cn(listRowClass, isSelected && listRowSelectedClass)}
      data-search-result-id={result.message.id}
      data-testid={`search-result-${String(result.message.sourceRowId)}`}
      onClick={onSelect}
      type="button"
    >
      <span className="block truncate text-body font-[var(--font-weight-strong)] text-text">
        {conversationTitle(result.conversation)}
      </span>
      <span className="mt-1 block truncate text-caption text-text-secondary">
        {sender} / {formatDateTime(result.message.sentAtUtc)}
      </span>
      <span className="mt-2 block break-words text-body text-text">
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
      </span>
      {result.message.attachments.length > 0 ? (
        <span className="mt-2 block text-micro text-text-tertiary">
          {result.message.attachments.length.toLocaleString()} attachment
          {result.message.attachments.length === 1 ? "" : "s"}
        </span>
      ) : null}
    </button>
  );
}

function CoverageWarning({
  coverage,
}: {
  coverage: SearchMessagesResponse["coverage"];
}) {
  // Only bounded scans can truncate; the fts coverage shape is always
  // complete, so this warning renders for the bounded-scan strategy alone.
  if (coverage.strategy !== "bounded-scan") {
    return null;
  }

  return (
    <InlineNotice kind="warning">
      {`Search examined the newest ${coverage.rowBudget.toLocaleString()} of ${coverage.candidateRows.toLocaleString()} candidate messages.`}{" "}
      Older matches may be omitted.
    </InlineNotice>
  );
}

function MessagesPane({
  actions,
  children,
  className,
  dialog,
  paneRef,
  testId,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * When set, the pane is rendered as a modal detail overlay with dialog
   * semantics and a programmatic focus target. Focus containment and
   * Escape-to-dismiss are owned by useModalFocusContainment at the
   * workspace level — a single audited mechanism, not per-pane traps.
   */
  dialog?: { label: string };
  paneRef?: Ref<HTMLElement>;
  testId?: string;
  title: string;
}) {
  return (
    <section
      aria-label={dialog?.label}
      aria-modal={dialog === undefined ? undefined : true}
      className={cn("flex h-[var(--layout-workspace-min)] min-w-0 flex-col bg-surface lg:h-full", className)}
      data-testid={testId}
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
        listRowClass,
        "px-4",
        isSelected && cn(listRowSelectedClass, "pl-5"),
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
  activationRevision,
  canHandleJump,
  getBackupClient,
  getMediaClient,
  jumpMessageId,
  onLoadTimelinePage,
  onSelectMessage,
  record,
  runPreviewTask,
  selectedMessageId,
  state,
  timelineRows,
}: {
  activationRevision: number;
  canHandleJump: boolean;
  getBackupClient: () => BackupWorkerClient;
  getMediaClient: () => MediaWorkerClient;
  jumpMessageId: string | undefined;
  onLoadTimelinePage: (direction: "after" | "before") => void;
  onSelectMessage: (messageId: string, conversationId: string) => void;
  record: RecentBackupRecord;
  runPreviewTask: RunPreviewTask;
  selectedMessageId: string | undefined;
  state: TimelineState;
  timelineRows: TimelineRow[];
}) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const findTimelineIndex = useCallback(
    (messageId: string) =>
      timelineRows.findIndex(
        (row) => row.kind === "message" && row.id === messageId,
      ),
    [timelineRows],
  );

  useVirtuosoJump({
    activationRevision,
    canHandleJump: canHandleJump && state.kind === "ready",
    findIndex: findTimelineIndex,
    jumpMessageId,
    virtuosoRef,
  });

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
      <div className="min-h-0 flex-1">
        <Virtuoso
          alignToBottom
          className="h-full"
          components={{
            Header: () => (
              <>
                {state.moreErrorBefore !== undefined ? (
                  <div className="p-3">
                    <InlineNotice kind="danger">{state.moreErrorBefore}</InlineNotice>
                  </div>
                ) : state.loadingBefore ? (
                  <div className="p-3 text-center text-caption text-text-secondary">
                    Loading earlier messages...
                  </div>
                ) : null}
              </>
            ),
            Footer: () => (
              <>
                {state.moreErrorAfter !== undefined ? (
                  <div className="p-3">
                    <InlineNotice kind="danger">{state.moreErrorAfter}</InlineNotice>
                  </div>
                ) : state.loadingAfter ? (
                  <div className="p-3 text-center text-caption text-text-secondary">
                    Loading later messages...
                  </div>
                ) : null}
              </>
            ),
          }}
          data={timelineRows}
          endReached={() => {
            if (state.page.hasMoreAfter && !state.loadingAfter) {
              onLoadTimelinePage("after");
            }
          }}
          firstItemIndex={state.firstItemIndex}
          initialTopMostItemIndex={findInitialTimelineIndex(
            timelineRows,
            state.page.anchorMessageId,
          )}
          startReached={() => {
            if (state.page.hasMoreBefore && !state.loadingBefore) {
              onLoadTimelinePage("before");
            }
          }}
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
          ref={virtuosoRef}
        />
      </div>
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
        data-message-id={message.id}
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
          <div
            className={cn(
              "relative min-w-[min(100%,calc(var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-24)_+_var(--space-4)))] rounded-bubble px-[calc(var(--space-12)_+_var(--space-2))] py-[calc(var(--space-8)_+_var(--space-2))] text-left text-body shadow-1 outline-none focus-visible:ring-2 focus-visible:ring-accent",
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
            data-message-id={message.id}
            data-testid={`message-${String(message.sourceRowId)}`}
            onClick={onSelect}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect();
              }
            }}
            role="button"
            tabIndex={0}
          >
            {message.attachments.length > 0 ? (
              <span className={cn("grid max-w-full gap-2", message.body.replaceAll("\uFFFC", "").trim().length > 0 && "mb-2")}>
                {message.attachments.map((attachment) => (
                  <AttachmentPreview
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
            {message.body.replaceAll("\uFFFC", "").trim().length > 0 ? (
              <span className="whitespace-pre-wrap break-words">{message.body.replaceAll("\uFFFC", "")}</span>
            ) : null}
            {message.reactions.length > 0 ? (
              <span className="absolute -top-4 right-2 flex flex-wrap gap-1">
                {message.reactions.map((reaction) => (
                  <span
                    className="flex h-6 min-w-[24px] items-center justify-center rounded-full border border-border bg-surface px-1.5 shadow-sm text-text"
                    key={reaction.id}
                    title={reactionLabel(reaction.kind)}
                  >
                    <ReactionIcon kind={reaction.kind} />
                  </span>
                ))}
              </span>
            ) : null}
          </div>
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

function useAttachmentPreview({
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
  const encryptedSession = useContext(EncryptedSessionContext);
  const [previewState, setPreviewState] = useState<AttachmentPreviewState>({
    kind: "idle",
  });
  const mountedRef = useRef(true);
  const previewRequestIdRef = useRef(0);
  const canReadSource = attachment.sourceDomain !== undefined && attachment.sourcePath !== undefined;

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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      previewRequestIdRef.current += 1;
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

      if (encryptedSession.isEncrypted && !encryptedSession.isUnlocked) {
        commitPreviewState(requestId, { kind: "needs-password" });
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
          if (!mountedRef.current || previewRequestIdRef.current !== requestId) {
            return;
          }

          const backupClient = getBackupClient();
          const sourceResult = await backupClient.api.readSourceFile(
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
            if (sourceResult.error.code === "backup_password_required") {
              commitPreviewState(requestId, { kind: "needs-password" });
              encryptedSession.requireUnlock();
              return;
            }
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
          const originalPreview = attachment.mediaKind === "image"
            ? createOriginalMediaPreviewState(
                "image",
                sourceResult.value.bytes,
                sourceResult.value.mime ?? attachment.mime,
              )
            : undefined;
          let originalPreviewHandled = false;

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
      encryptedSession,
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
  }, [
    attachment,
    attachment.mediaKind,
    encryptedSession.revision,
    loadPreview,
  ]);

  useEffect(
    () => () => {
      if (previewState.kind === "image" || previewState.kind === "video") {
        URL.revokeObjectURL(previewState.url);
      }
    },
    [previewState],
  );

  return { previewState, loadPreview };
}

function AttachmentPreview({
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
  const encryptedSession = useContext(EncryptedSessionContext);
  const { previewState, loadPreview } = useAttachmentPreview({
    attachment,
    getBackupClient,
    getMediaClient,
    record,
    runPreviewTask,
  });

  return (
    <span className="block">
      {previewState.kind === "image" ? (
        <>
          <img
            alt={attachment.filename ?? "Attachment preview"}
            className="max-h-[calc(var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64))] max-w-[calc(var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64)_+_var(--space-64))] rounded-md border border-border object-contain bg-surface-sunken"
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
          onClick={(e) => {
            e.stopPropagation();
            void loadPreview(true);
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Load preview
        </Button>
      ) : previewState.kind === "needs-password" ? (
        <Button
          onClick={(event) => {
            event.stopPropagation();
            encryptedSession.focusUnlock();
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          <LockKeyhole aria-hidden="true" className="size-4" />
          Unlock attachments
        </Button>
      ) : previewState.kind === "unsupported" ? (
        <span className="text-caption text-text-secondary">{previewState.message}</span>
      ) : previewState.kind === "error" ? (
        previewState.message.includes("too large to decode") ? (
          <div className="flex h-32 w-32 items-center justify-center rounded-md border border-border bg-surface-sunken p-4 text-center">
            <div className="flex flex-col items-center gap-2 text-text-secondary">
              <ImageOff aria-hidden="true" className="size-6" />
              <span className="text-micro font-[var(--font-weight-strong)]">Image too large</span>
            </div>
          </div>
        ) : (
          <span className="text-caption text-danger">{previewState.message}</span>
        )
      ) : attachment.mediaKind === "video" ? (
        <Button
          onClick={(e) => {
            e.stopPropagation();
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
  );
}

function AttachmentDetailCard({
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
  const encryptedSession = useContext(EncryptedSessionContext);
  const [extractState, setExtractState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "permission-granted" }
    | { kind: "success" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  
  const mountedRef = useRef(true);
  const extractStubCleanupRef = useRef<(() => void) | undefined>(undefined);
  const canReadSource = attachment.sourceDomain !== undefined && attachment.sourcePath !== undefined;

  const setExtractStateIfMounted = useCallback(
    (nextState: typeof extractState) => {
      if (mountedRef.current) {
        setExtractState(nextState);
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      extractStubCleanupRef.current?.();
      extractStubCleanupRef.current = undefined;
    };
  }, []);

  const extractOriginal = async () => {
    if (!canReadSource) {
      setExtractStateIfMounted({
        kind: "error",
        message: "Cannot extract this attachment because source provenance is incomplete.",
      });
      return;
    }

    if (encryptedSession.isEncrypted && !encryptedSession.isUnlocked) {
      setExtractStateIfMounted({
        kind: "error",
        message: "Unlock encrypted source attachments before extracting the original.",
      });
      encryptedSession.focusUnlock();
      return;
    }

    setExtractStateIfMounted({ kind: "running" });

    try {
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
          // Best-effort cleanup: a denied or unsupported remove cannot hide
          // the original extraction failure from the user.
        }
      };

      extractStubCleanupRef.current = () => {
        void removeStub();
      };

      try {
        const backupClient = getBackupClient();
        const sourceResult = await backupClient.api.readSourceFile(
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
          if (sourceResult.error.code === "backup_password_required") {
            encryptedSession.requireUnlock();
          }
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

        stubPending = false;
        extractStubCleanupRef.current = undefined;
        setExtractStateIfMounted({ kind: "success" });
      } finally {
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
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <span className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-[var(--control-height-md)] shrink-0 items-center justify-center rounded-md bg-surface text-text-tertiary shadow-sm border border-border">
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
        <AttachmentPreview
          attachment={attachment}
          getBackupClient={getBackupClient}
          getMediaClient={getMediaClient}
          record={record}
          runPreviewTask={runPreviewTask}
        />
      </span>

      <div className="mt-4 rounded-md border border-border bg-surface-sunken p-3 text-caption">
        <dl
          className="grid gap-x-3 gap-y-1"
          style={{ gridTemplateColumns: "max-content minmax(0, 1fr)" }}
        >
          <dt className="text-text-tertiary">Domain</dt>
          <dd className="break-all font-mono text-text-secondary">{attachment.sourceDomain}</dd>
          <dt className="text-text-tertiary">Path</dt>
          <dd className="break-all font-mono text-text-secondary">{attachment.sourcePath}</dd>
          <dt className="text-text-tertiary">GUID</dt>
          <dd className="break-all font-mono text-text-secondary">{attachment.sourceGuid}</dd>
          <dt className="text-text-tertiary">
            {record.isEncrypted ? "Decrypted content SHA-256" : "SHA-256"}
          </dt>
          <dd className="break-all font-mono text-text-secondary">{attachment.sha256}</dd>
        </dl>
      </div>

      <span className="mt-4 flex items-center gap-2 border-t border-border pt-4">
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
    </div>
  );
}

function DetailPane({
  getBackupClient,
  getMediaClient,
  record,
  runPreviewTask,
  state,
}: {
  getBackupClient: () => BackupWorkerClient;
  getMediaClient: () => MediaWorkerClient;
  record: RecentBackupRecord;
  runPreviewTask: RunPreviewTask;
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
          <div className="mt-3 rounded-md border border-border bg-surface-sunken p-3 text-caption">
            <dl
              className="grid gap-x-3 gap-y-1"
              style={{ gridTemplateColumns: "max-content minmax(0, 1fr)" }}
            >
              <dt className="text-text-tertiary">ID</dt>
              <dd className="break-all font-mono text-text-secondary">{message.id}</dd>
              <dt className="text-text-tertiary">Thread</dt>
              <dd className="break-all text-text-secondary">{conversationTitle(conversation)}</dd>
              <dt className="text-text-tertiary">Sender</dt>
              <dd className="break-all text-text-secondary">
                {message.sender === undefined ? "Unknown" : participantLabel(message.sender)}
              </dd>
              <dt className="text-text-tertiary">Dir</dt>
              <dd className="text-text-secondary">{message.isFromMe ? "Sent" : "Received"}</dd>
              <dt className="text-text-tertiary">Service</dt>
              <dd className="text-text-secondary">{message.service}</dd>
              <dt className="text-text-tertiary">Sent</dt>
              <dd className="text-text-secondary">{formatDateTime(message.sentAtUtc)}</dd>
              {message.dateDelivered ? (
                <>
                  <dt className="text-text-tertiary">Delivered</dt>
                  <dd className="text-text-secondary">{formatDateTime(message.dateDelivered)}</dd>
                </>
              ) : null}
              {message.dateRead ? (
                <>
                  <dt className="text-text-tertiary">Read</dt>
                  <dd className="text-text-secondary">{formatDateTime(message.dateRead)}</dd>
                </>
              ) : null}
              <dt className="text-text-tertiary">Raw TS</dt>
              <dd className="font-mono text-text-secondary">{message.rawTimestamp}</dd>
              <dt className="text-text-tertiary">GUID</dt>
              <dd className="break-all font-mono text-text-secondary">{message.sourceGuid}</dd>
              <dt className="text-text-tertiary">Row</dt>
              <dd className="font-mono text-text-secondary">{message.sourceRowId}</dd>
              {message.edited ? (
                <>
                  <dt className="text-text-tertiary">Edited</dt>
                  <dd className="text-text-secondary">Yes</dd>
                </>
              ) : null}
              {message.unsent ? (
                <>
                  <dt className="text-text-tertiary">Unsent</dt>
                  <dd className="text-text-secondary">Yes</dd>
                </>
              ) : null}
              {message.isSystemEvent ? (
                <>
                  <dt className="text-text-tertiary">System</dt>
                  <dd className="text-text-secondary">Yes</dd>
                </>
              ) : null}
            </dl>
          </div>
        </section>

        <section>
          <h3 className="text-heading text-text">Participants</h3>
          <div className="mt-3 rounded-md border border-border bg-surface-sunken p-3 text-caption">
            <dl
              className="grid gap-x-3 gap-y-1"
              style={{ gridTemplateColumns: "max-content minmax(0, 1fr)" }}
            >
              {conversation.participants.map((participant) => (
                <Fragment key={participant.id}>
                  <dt className="text-text-tertiary text-right">{participantLabel(participant)}</dt>
                  <dd className="break-all font-mono text-text-secondary">
                    {participant.handle}
                    {participant.isSelf ? " (self)" : ""}
                  </dd>
                </Fragment>
              ))}
            </dl>
          </div>
        </section>

        <section>
          <h3 className="text-heading text-text">Attachments</h3>
          {message.attachments.length === 0 ? (
            <p className="mt-2 text-caption text-text-secondary">No attachments.</p>
          ) : (
            <div className="mt-3 grid gap-3">
              {message.attachments.map((attachment) => (
                <AttachmentDetailCard
                  attachment={attachment}
                  getBackupClient={getBackupClient}
                  getMediaClient={getMediaClient}
                  key={attachment.id}
                  record={record}
                  runPreviewTask={runPreviewTask}
                />
              ))}
            </div>
          )}
        </section>

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

function getSearchResponse<TResponse>(
  state: SearchPaneState<TResponse>,
): TResponse | undefined {
  return state.kind === "idle" ? undefined : state.response;
}

function buildResultsScopeKey(
  token: number,
  conversationId: string | undefined,
): string {
  return `${String(token)}:${conversationId ?? ""}`;
}

/**
 * Sentinel request key held while a replacement search is in flight; it can
 * never equal a scope key, so stale pagination against the outgoing search
 * is always detected.
 */
function buildReplacementResultsKey(token: number): string {
  return `replacement:${String(token)}`;
}

function clearSelectionSearchParams(
  current: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(current);

  next.delete("conversation");
  next.delete("message");

  return next;
}

function detailDockMediaQuery(): MediaQueryList {
  // CSS media queries cannot reference custom properties, so the dock
  // threshold token is resolved once per query here. Everything that docks
  // or undocks (grid columns, dialog semantics, focus behavior) derives from
  // this one media query — never from a stylesheet breakpoint.
  const dockWidth = getComputedStyle(document.documentElement)
    .getPropertyValue("--layout-detail-dock")
    .trim();

  return window.matchMedia(`(min-width: ${dockWidth})`);
}

/**
 * The shared load-more state machine for both search panes: guards against
 * double-loads and exhausted lists, keeps prior pages on failure, and drops
 * stale responses after a replacement search or scope change.
 */
async function loadMoreSearchPage<TResponse>({
  fetchPage,
  getItemCount,
  getTotal,
  isStale,
  mergeResponses,
  setState,
  state,
}: {
  fetchPage: (offset: number) => Promise<WorkerResult<TResponse>>;
  getItemCount: (response: TResponse) => number;
  getTotal: (response: TResponse) => number;
  isStale: () => boolean;
  mergeResponses: (current: TResponse, next: TResponse) => TResponse;
  setState: Dispatch<SetStateAction<SearchPaneState<TResponse>>>;
  state: SearchPaneState<TResponse>;
}): Promise<void> {
  if (state.kind !== "ready") {
    return;
  }

  const response = state.response;

  if (state.loadingMore || getItemCount(response) >= getTotal(response)) {
    return;
  }

  setState({ ...state, loadingMore: true, moreError: undefined });

  try {
    const result = await fetchPage(getItemCount(response));

    setState((current) => {
      if (current.kind !== "ready" || isStale()) {
        return current;
      }

      if (!result.ok) {
        return {
          ...current,
          loadingMore: false,
          moreError: formatWorkerResultError(result.error),
        };
      }

      return {
        kind: "ready",
        loadingMore: false,
        response: mergeResponses(current.response, result.value),
      };
    });
  } catch (cause) {
    setState((current) =>
      current.kind === "ready" && !isStale()
        ? {
            ...current,
            loadingMore: false,
            moreError: formatError(cause),
          }
        : current,
    );
  }
}

function buildSearchFilters(input: {
  fromDate: string;
  hasAttachment: boolean;
  participantQuery: string;
  toDate: string;
}): SearchConversationFilters {
  return {
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
    return rows.length > 0 ? rows.length - 1 : 0;
  }

  const index = rows.findIndex((row) => row.kind === "message" && row.id === messageId);

  return index < 0 ? (rows.length > 0 ? rows.length - 1 : 0) : index;
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

function ReactionIcon({ kind }: { kind: string }) {
  switch (kind) {
    case "loved":
      return (
        <svg viewBox="0 0 24 24" fill="#ff3b30" className="size-4">
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
        </svg>
      );
    case "liked":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-4 text-text-secondary">
          <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z" />
        </svg>
      );
    case "disliked":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-4 text-text-secondary">
          <path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z" />
        </svg>
      );
    case "laughed":
      return <span className="font-[var(--font-weight-strong)] text-[10px] leading-tight text-text-secondary">HA<br/>HA</span>;
    case "emphasized":
      return <span className="font-[var(--font-weight-strong)] text-[14px] italic leading-none text-text-secondary">!!</span>;
    case "questioned":
      return <span className="font-[var(--font-weight-strong)] text-[14px] leading-none text-text-secondary">?</span>;
    default:
      return <span className="font-[var(--font-weight-strong)] text-[12px] leading-none text-text-secondary">?</span>;
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
