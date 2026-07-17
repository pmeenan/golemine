import * as Dialog from "@radix-ui/react-dialog";
import { FilePlus2, FileText, Loader2, Plus, X } from "lucide-react";
import { type SyntheticEvent, useEffect, useId, useState } from "react";
import { Link } from "react-router";

import { Button } from "../../components/ui/button";
import "../../components/ui/dialog-shell.css";
import type { RecentBackupRecord } from "../../lib/recents";
import type { createDbWorkerClient } from "../../lib/worker-client";
import type {
  DbMessageRecord,
  DbReportSummary,
} from "../../lib/worker-types";
import { maxReportTitleLength } from "../../workers/shared/report-limits";
import {
  formatError,
  formatWorkerResultError,
} from "../m3/m3-shared";

type DbWorkerClient = ReturnType<typeof createDbWorkerClient>;

export function ReportPickerDialog({
  getDbClient,
  message,
  onClose,
  record,
}: {
  getDbClient: () => DbWorkerClient;
  message: DbMessageRecord | undefined;
  onClose: () => void;
  record: RecentBackupRecord;
}) {
  const titleId = useId();
  const [reports, setReports] = useState<DbReportSummary[]>([]);
  const [selectedReportIds, setSelectedReportIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [pendingReportId, setPendingReportId] = useState<string>();
  const [newReportTitle, setNewReportTitle] = useState("");
  const [createError, setCreateError] = useState<string>();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (message === undefined) {
      setState({ kind: "idle" });
      return;
    }

    const active = { current: true };
    const client = getDbClient();
    setState({ kind: "loading" });
    setCreateError(undefined);
    setNewReportTitle("");

    void Promise.all([
      client.api.listReports({ backupId: record.id }),
      client.api.getMessageReportMembership({
        backupId: record.id,
        messageId: message.id,
      }),
    ])
      .then(([reportsResult, membershipResult]) => {
        if (!active.current) {
          return;
        }

        if (!reportsResult.ok || !membershipResult.ok) {
          setState({
            kind: "error",
            message: !reportsResult.ok
              ? formatWorkerResultError(reportsResult.error)
              : !membershipResult.ok
                ? formatWorkerResultError(membershipResult.error)
                : "Report selections could not be loaded.",
          });
          return;
        }

        setReports(reportsResult.value.reports);
        setSelectedReportIds(new Set(membershipResult.value.reportIds));
        setState({ kind: "ready" });
      })
      .catch((cause: unknown) => {
        if (active.current) {
          setState({ kind: "error", message: formatError(cause) });
        }
      });

    return () => {
      active.current = false;
    };
  }, [getDbClient, message, record.id]);

  const toggleReport = async (reportId: string, selected: boolean) => {
    if (message === undefined || pendingReportId !== undefined) {
      return;
    }

    // Snapshot both optimistic states wholesale so a failed toggle restores
    // them without re-deriving the count adjustment in reverse.
    const previousReportIds = new Set(selectedReportIds);
    const previousReports = reports;
    const nextReportIds = new Set(selectedReportIds);

    if (selected) {
      nextReportIds.add(reportId);
    } else {
      nextReportIds.delete(reportId);
    }

    setPendingReportId(reportId);
    setSelectedReportIds(nextReportIds);
    setReports((current) =>
      current.map((report) =>
        report.id === reportId
          ? {
              ...report,
              itemCount: Math.max(0, report.itemCount + (selected ? 1 : -1)),
            }
          : report,
      ),
    );
    try {
      const result = await getDbClient().api.setMessageReportMembership({
        backupId: record.id,
        messageId: message.id,
        reportId,
        selected,
      });

      if (!result.ok) {
        throw new Error(formatWorkerResultError(result.error), {
          cause: result.error,
        });
      }

      setSelectedReportIds(new Set(result.value.reportIds));
    } catch (cause) {
      setSelectedReportIds(previousReportIds);
      setReports(previousReports);
      setState({ kind: "error", message: formatError(cause) });
    } finally {
      setPendingReportId(undefined);
    }
  };

  const createReport = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();

    const title = newReportTitle.trim();
    if (message === undefined || title.length === 0 || creating) {
      return;
    }

    setCreating(true);
    setCreateError(undefined);
    try {
      const created = await getDbClient().api.createReport({
        backupId: record.id,
        title,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });

      if (!created.ok) {
        setCreateError(formatWorkerResultError(created.error));
        return;
      }

      const membership = await getDbClient().api.setMessageReportMembership({
        backupId: record.id,
        messageId: message.id,
        reportId: created.value.id,
        selected: true,
      });

      if (!membership.ok) {
        setCreateError(formatWorkerResultError(membership.error));
        return;
      }

      setReports((current) => [
        { ...created.value, itemCount: 1 },
        ...current,
      ]);
      setSelectedReportIds(new Set(membership.value.reportIds));
      setNewReportTitle("");
    } catch (cause) {
      setCreateError(formatError(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog.Root
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={message !== undefined}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="golemine-dialog-overlay fixed inset-0 z-50 bg-[var(--overlay-scrim)]" />
        <Dialog.Content
          aria-labelledby={titleId}
          className="golemine-dialog-content fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh_-_var(--space-48))] w-[calc(100%_-_var(--space-32))] max-w-[var(--layout-dialog-confirm)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-surface-raised text-text shadow-3"
          data-testid="report-picker-dialog"
        >
          <div className="flex items-start justify-between gap-4 border-b border-border p-5">
            <div className="min-w-0">
              <Dialog.Title className="text-heading text-text" id={titleId}>
                Add message to reports
              </Dialog.Title>
              <Dialog.Description className="mt-1 line-clamp-2 text-caption text-text-secondary">
                {message === undefined || message.body.trim().length === 0
                  ? "Message without text"
                  : message.body.trim()}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button aria-label="Close report picker" size="icon" variant="ghost">
                <X aria-hidden="true" className="size-4" />
              </Button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 overflow-y-auto p-5">
            {state.kind === "loading" || state.kind === "idle" ? (
              <p className="flex items-center gap-2 text-body text-text-secondary" role="status">
                <Loader2 aria-hidden="true" className="size-4" />
                Loading reports.
              </p>
            ) : null}
            {state.kind === "error" ? (
              <p className="rounded-md bg-danger-subtle p-3 text-caption text-danger" role="alert">
                {state.message}
              </p>
            ) : null}
            {state.kind === "ready" && reports.length === 0 ? (
              <p className="rounded-md border border-border bg-surface-sunken p-4 text-body text-text-secondary">
                No reports yet. Create a named report below and this message will be added to it.
              </p>
            ) : null}
            {state.kind === "ready" && reports.length > 0 ? (
              <ul className="grid gap-2" aria-label="Reports">
                {reports.map((report) => {
                  const selected = selectedReportIds.has(report.id);
                  return (
                    <li
                      className="flex items-center gap-3 rounded-md border border-border bg-surface p-3"
                      key={report.id}
                    >
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                        <input
                          checked={selected}
                          disabled={pendingReportId !== undefined}
                          onChange={(event) => {
                            void toggleReport(report.id, event.currentTarget.checked);
                          }}
                          type="checkbox"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-body font-[var(--font-weight-strong)] text-text">
                            {report.title}
                          </span>
                          <span className="mt-1 block text-caption text-text-secondary">
                            {report.itemCount.toLocaleString()} selected {report.itemCount === 1 ? "message" : "messages"}
                          </span>
                        </span>
                      </label>
                      <Button asChild size="icon" variant="ghost">
                        <Link
                          aria-label={`Open report ${report.title}`}
                          to={`/backup/${encodeURIComponent(record.id)}/report/${encodeURIComponent(report.id)}`}
                        >
                          <FileText aria-hidden="true" className="size-4" />
                        </Link>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>

          <form className="border-t border-border p-5" onSubmit={(event) => void createReport(event)}>
            <label className="text-caption font-[var(--font-weight-strong)] text-text" htmlFor={`${titleId}-new-report`}>
              New report name
            </label>
            <div className="mt-2 flex gap-2">
              <input
                className="h-[var(--control-height-lg)] min-w-0 flex-1 rounded-md border border-border-strong bg-surface-sunken px-3 text-body text-text"
                id={`${titleId}-new-report`}
                maxLength={maxReportTitleLength}
                onChange={(event) => {
                  setNewReportTitle(event.currentTarget.value);
                }}
                placeholder="Exhibit A"
                value={newReportTitle}
              />
              <Button
                disabled={creating || newReportTitle.trim().length === 0}
                type="submit"
                variant="primary"
              >
                {creating ? (
                  <Loader2 aria-hidden="true" className="size-4" />
                ) : (
                  <Plus aria-hidden="true" className="size-4" />
                )}
                Create report
              </Button>
            </div>
            {createError === undefined ? null : (
              <p className="mt-2 text-caption text-danger" role="alert">
                {createError}
              </p>
            )}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ManageReportsButton({
  className,
  onClick,
}: {
  className?: string;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label="Add or remove message from reports"
      className={className}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      size="sm"
      type="button"
      variant="ghost"
    >
      <FilePlus2 aria-hidden="true" className="size-4" />
      Report
    </Button>
  );
}
