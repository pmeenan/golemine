/* eslint-disable react-refresh/only-export-components */
import { AlertTriangle, ArrowLeft, Database, Loader2 } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link } from "react-router";

import { EmptyState, MetadataRow, PageShell } from "../../components/layout/page-shell";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import type { RecentBackupRecord } from "../../lib/recents";
import {
  createBackupRecentsStore,
  type BackupRecentsStore,
} from "../../lib/recents";
import type { createDbWorkerClient } from "../../lib/worker-client";
import {
  formatWorkerErrorPayload,
  type DbAttachmentMediaKind,
  type DbConversationSummary,
  type WorkerErrorPayload,
} from "../../lib/worker-types";

type DbWorkerClient = ReturnType<typeof createDbWorkerClient>;

export type RecentRouteState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "blocked"; record: RecentBackupRecord; message: string }
  | { kind: "ready"; record: RecentBackupRecord };

export type ConversationsState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      conversations: DbConversationSummary[];
      loadingMore: boolean;
      moreError?: string;
      total: number;
    };

export function isInlinePreviewMediaKind(kind: DbAttachmentMediaKind): boolean {
  return kind === "image" || kind === "heic" || kind === "video";
}

export function isThumbnailPreviewMediaKind(kind: DbAttachmentMediaKind): boolean {
  return kind === "image" || kind === "heic";
}

export async function loadM3RecentRouteState(
  store: BackupRecentsStore,
  backupId: string,
): Promise<RecentRouteState> {
  try {
    const record = backupId.trim().length === 0 ? undefined : await store.get(backupId);

    if (record === undefined) {
      return { kind: "missing" };
    }

    switch (record.ingestStatus) {
      case "ingested":
        return { kind: "ready", record };
      case "not-ingested":
        return {
          kind: "blocked",
          record,
          message: "This backup has not been ingested yet.",
        };
      case "needs-reingest":
        return {
          kind: "blocked",
          record,
          message: "This backup needs to be re-ingested before browsing messages.",
        };
      case "failed":
        return {
          kind: "blocked",
          record,
          message: "The last ingest failed. Rebuild the message database from the overview.",
        };
      case "ingesting":
        return {
          kind: "blocked",
          record,
          message: "This backup is still ingesting. Return after the rebuild completes.",
        };
    }
  } catch (cause) {
    return {
      kind: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Route bootstrap shared by the M3 messages and search routes: owns a recents
 * store and resolves the gate state for the backup id in the URL.
 */
export function useRecentRouteState(backupId: string): RecentRouteState {
  const recentsStore = useMemo(() => createBackupRecentsStore(), []);
  const [routeState, setRouteState] = useState<RecentRouteState>({
    kind: "loading",
  });

  useEffect(() => {
    const active = { current: true };

    setRouteState({ kind: "loading" });
    void loadM3RecentRouteState(recentsStore, backupId).then((nextState) => {
      if (active.current) {
        setRouteState(nextState);
      }
    });

    return () => {
      active.current = false;
    };
  }, [backupId, recentsStore]);

  return routeState;
}

/**
 * Shared conversation-list pagination state machine (initial page load plus
 * offset-guarded load-more) used by the messages and search routes.
 */
export function useConversationPages({
  backupId,
  getDbClient,
  pageSize,
}: {
  backupId: string;
  getDbClient: () => DbWorkerClient;
  pageSize: number;
}): {
  conversationsState: ConversationsState;
  loadMoreConversations: () => Promise<void>;
} {
  const [conversationsState, setConversationsState] = useState<ConversationsState>({
    kind: "loading",
  });

  useEffect(() => {
    const active = { current: true };
    const client = getDbClient();

    setConversationsState({ kind: "loading" });
    void (async () => {
      try {
        const result = await client.api.listConversations({
          backupId,
          limit: pageSize,
        });

        if (!active.current) {
          return;
        }

        if (!result.ok) {
          setConversationsState({
            kind: "error",
            message: formatWorkerResultError(result.error),
          });
          return;
        }

        setConversationsState({
          kind: "ready",
          conversations: result.value.conversations,
          loadingMore: false,
          total: result.value.total,
        });
      } catch (cause) {
        if (active.current) {
          setConversationsState({ kind: "error", message: formatError(cause) });
        }
      }
    })();

    return () => {
      active.current = false;
    };
  }, [backupId, getDbClient, pageSize]);

  const loadMoreConversations = useCallback(async () => {
    let offset: number | undefined;

    setConversationsState((current) => {
      if (
        current.kind !== "ready" ||
        current.loadingMore ||
        current.conversations.length >= current.total
      ) {
        return current;
      }

      offset = current.conversations.length;

      return {
        ...current,
        loadingMore: true,
        moreError: undefined,
      };
    });

    if (offset === undefined) {
      return;
    }

    const client = getDbClient();

    try {
      const result = await client.api.listConversations({
        backupId,
        limit: pageSize,
        offset,
      });

      setConversationsState((current) => {
        if (current.kind !== "ready") {
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
          ...current,
          conversations: mergeById(
            current.conversations,
            result.value.conversations,
          ),
          loadingMore: false,
          total: result.value.total,
        };
      });
    } catch (cause) {
      setConversationsState((current) =>
        current.kind === "ready"
          ? {
              ...current,
              loadingMore: false,
              moreError: formatError(cause),
            }
          : current,
      );
    }
  }, [backupId, getDbClient, pageSize]);

  return { conversationsState, loadMoreConversations };
}

/**
 * Order-preserving concatenation of two pages that drops duplicate items by
 * key. Position follows the first occurrence, but for keys present in both
 * inputs the emitted value is the SECOND input's instance: when a fresh
 * overlapping page is merged in front of already-rendered state (timeline
 * "load earlier"), the rows the user is looking at keep their existing object
 * references, so React effects (attachment previews) do not re-fire.
 * Content is interchangeable either way because the derived DB is immutable
 * while a backup route is mounted.
 */
export function mergeBy<TItem>(
  first: readonly TItem[],
  second: readonly TItem[],
  keyOf: (item: TItem) => string,
): TItem[] {
  const byKeyInSecond = new Map<string, TItem>();

  for (const item of second) {
    const key = keyOf(item);

    if (!byKeyInSecond.has(key)) {
      byKeyInSecond.set(key, item);
    }
  }

  const seen = new Set<string>();
  const merged: TItem[] = [];

  for (const item of [...first, ...second]) {
    const key = keyOf(item);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(byKeyInSecond.get(key) ?? item);
  }

  return merged;
}

export function mergeById<TItem extends { id: string }>(
  first: readonly TItem[],
  second: readonly TItem[],
): TItem[] {
  return mergeBy(first, second, (item) => item.id);
}

export function RecentRouteGate({
  backupId,
  children,
  description,
  routeState,
  title,
}: {
  backupId: string;
  children: (record: RecentBackupRecord) => ReactNode;
  description: string;
  routeState: RecentRouteState;
  title: string;
}) {
  if (routeState.kind === "loading") {
    return (
      <PageShell
        description="Loading stored metadata for this backup."
        eyebrow={title}
        title="Backup workspace"
      >
        <EmptyState icon={<Loader2 aria-hidden="true" className="size-6" />}>
          Loading backup metadata.
        </EmptyState>
      </PageShell>
    );
  }

  if (routeState.kind === "error") {
    return (
      <PageShell
        description="The recent backup list could not be read."
        eyebrow={title}
        title="Backup unavailable"
      >
        <EmptyState
          action={
            <Button asChild variant="secondary">
              <Link to="/">Return to workspace</Link>
            </Button>
          }
          icon={<AlertTriangle aria-hidden="true" className="size-6" />}
        >
          {routeState.message}
        </EmptyState>
      </PageShell>
    );
  }

  if (routeState.kind === "missing") {
    return (
      <PageShell
        description="This backup is not in the local recent-backups list for this browser profile."
        eyebrow={title}
        title="Backup not found"
      >
        <EmptyState
          action={
            <Button asChild variant="primary">
              <Link to="/">Open backup</Link>
            </Button>
          }
          icon={<Database aria-hidden="true" className="size-6" />}
        >
          Open the backup folder again to restore the local recent entry.
        </EmptyState>
      </PageShell>
    );
  }

  if (routeState.kind === "blocked") {
    return (
      <PageShell
        description={description}
        eyebrow={title}
        title={routeState.record.friendlyName}
      >
        <EmptyState
          action={
            <Button asChild variant="primary">
              <Link to={`/backup/${encodeURIComponent(backupId)}`}>
                <ArrowLeft aria-hidden="true" className="size-4" />
                Open overview
              </Link>
            </Button>
          }
          icon={<Database aria-hidden="true" className="size-6" />}
        >
          {routeState.message}
        </EmptyState>
      </PageShell>
    );
  }

  return children(routeState.record);
}

export function DataRow({
  label,
  value,
}: {
  label: string;
  value: string | number | boolean | undefined;
}) {
  return <MetadataRow label={label} value={formatFieldValue(value)} />;
}

export function InlineNotice({
  children,
  kind = "info",
}: {
  children: ReactNode;
  kind?: "danger" | "info" | "warning";
}) {
  return (
    <p
      className={cn(
        "rounded-md border px-3 py-2 text-caption",
        kind === "danger" && "border-danger bg-danger-subtle text-danger",
        kind === "info" &&
          "border-transparent bg-[var(--info-subtle)] text-[var(--info-foreground)]",
        kind === "warning" &&
          "border-transparent bg-[var(--warning-subtle)] text-[var(--warning-foreground)]",
      )}
      role={kind === "danger" ? "alert" : "status"}
    >
      {children}
    </p>
  );
}

export function formatError(cause: unknown): string {
  if (isWorkerErrorPayload(cause)) {
    return formatWorkerErrorPayload(cause);
  }

  return cause instanceof Error ? cause.message : String(cause);
}

export function formatWorkerResultError(error: WorkerErrorPayload): string {
  return formatWorkerErrorPayload(error);
}

export function formatDateTime(value: string | undefined): string {
  if (value === undefined) {
    return "Not present";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatDay(value: string | undefined): string {
  if (value === undefined) {
    return "Undated";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function formatBytes(value: number | undefined): string {
  if (value === undefined) {
    return "Unknown size";
  }

  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value >= 1024 * 1024 ? 1 : 0,
    style: "unit",
    unit: value >= 1024 * 1024 ? "megabyte" : value >= 1024 ? "kilobyte" : "byte",
    unitDisplay: "short",
  }).format(value >= 1024 * 1024 ? value / (1024 * 1024) : value >= 1024 ? value / 1024 : value);
}

export function participantLabel(input: {
  contactName?: string;
  handle: string;
  isSelf?: boolean;
}): string {
  if (input.isSelf === true) {
    return input.contactName ?? "Me";
  }

  return input.contactName ?? input.handle;
}

export function conversationTitle(input: {
  displayName?: string;
  participants: readonly { contactName?: string; handle: string; isSelf?: boolean }[];
}): string {
  if (input.displayName !== undefined && input.displayName.trim().length > 0) {
    return input.displayName;
  }

  const otherParticipants = input.participants.filter(
    (participant) => participant.isSelf !== true,
  );
  const participants =
    otherParticipants.length > 0 ? otherParticipants : input.participants;

  return participants.map(participantLabel).join(", ") || "Unnamed conversation";
}

function formatFieldValue(value: string | number | boolean | undefined): string {
  if (value === undefined) {
    return "Not present";
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  return String(value);
}

function isWorkerErrorPayload(value: unknown): value is WorkerErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "worker" in value &&
    "code" in value &&
    "message" in value
  );
}
