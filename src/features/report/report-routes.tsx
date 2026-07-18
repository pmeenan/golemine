import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  FileText,
  Loader2,
  MessageSquareText,
  Printer,
  Save,
  Trash2,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useParams } from "react-router";

import {
  BackupPasswordForm,
  useBackupPasswordForm,
} from "../../components/backup/backup-password-form";
import {
  EmptyState,
  PageShell,
  Panel,
  PanelHeader,
} from "../../components/layout/page-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmationDialog } from "../../components/ui/confirmation-dialog";
import { appName, appVersion } from "../../lib/constants";
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
  DbAttachmentSummary,
  DbIngestSummary,
  DbReport,
  DbReportItem,
  DbReportSummary,
  ReadSourceFileResponse,
} from "../../lib/worker-types";
import { defaultThumbnailMaxPixelSize } from "../../workers/shared/media-limits";
import {
  maxCaseFieldLength,
  maxReportNoteLength,
  maxReportTitleLength,
} from "../../workers/shared/report-limits";
import {
  cleanMessageBody,
  conversationTitle,
  formatBytes,
  formatDateTime,
  formatError,
  formatWorkerResultError,
  participantLabel,
  RecentRouteGate,
  useRecentRouteState,
} from "../m3/m3-shared";

type DbWorkerClient = ReturnType<typeof createDbWorkerClient>;
type BackupWorkerClient = ReturnType<typeof createBackupWorkerClient>;
type MediaWorkerClient = ReturnType<typeof createMediaWorkerClient>;

type ReportLoadState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; report: DbReport; ingestSummary?: DbIngestSummary };

interface EditableReportItem {
  item: DbReportItem;
  note: string;
}

interface AttachmentProvenance {
  attachment: DbAttachmentSummary;
  response?: ReadSourceFileResponse;
  error?: string;
  previewUrl?: string;
}

type ProvenanceState =
  | { kind: "idle" }
  | { kind: "needs-permission" }
  | { kind: "needs-password" }
  | { kind: "loading"; label: string }
  | { kind: "ready"; attachments: AttachmentProvenance[]; exportTimestamp: string }
  | { kind: "error"; message: string };

function useRouteIds(): { backupId: string; reportId: string } {
  const { id, reportId } = useParams<{ id: string; reportId: string }>();
  return { backupId: id ?? "", reportId: reportId ?? "" };
}

function useReportData(
  backupId: string,
  reportId: string,
): {
  clientRef: React.RefObject<DbWorkerClient | undefined>;
  state: ReportLoadState;
  applyReport: (report: DbReport) => void;
} {
  const clientRef = useRef<DbWorkerClient | undefined>(undefined);
  const [state, setState] = useState<ReportLoadState>({ kind: "loading" });

  useEffect(() => {
    const active = { current: true };
    const client = (clientRef.current ??= createDbWorkerClient());
    setState({ kind: "loading" });
    void Promise.all([
      client.api.getReport({ backupId, reportId }),
      client.api.getIngestSummary(backupId),
    ])
      .then(([reportResult, summaryResult]) => {
        if (!active.current) {
          return;
        }
        if (!reportResult.ok || !summaryResult.ok) {
          setState({
            kind: "error",
            message: !reportResult.ok
              ? formatWorkerResultError(reportResult.error)
              : !summaryResult.ok
                ? formatWorkerResultError(summaryResult.error)
                : "The report could not be read.",
          });
          return;
        }
        if (reportResult.value === undefined) {
          setState({ kind: "missing" });
          return;
        }
        setState({
          kind: "ready",
          report: reportResult.value,
          ...(summaryResult.value === undefined
            ? {}
            : { ingestSummary: summaryResult.value }),
        });
      })
      .catch((cause: unknown) => {
        if (active.current) {
          setState({ kind: "error", message: formatError(cause) });
        }
      });

    return () => {
      active.current = false;
    };
  }, [backupId, reportId]);

  useEffect(
    () => () => {
      clientRef.current?.release();
      clientRef.current = undefined;
    },
    [],
  );

  // saveReport already returns the fully hydrated report; applying it
  // directly avoids re-running the expensive getReport read after a save.
  const applyReport = useCallback((report: DbReport) => {
    setState((current) =>
      current.kind === "ready" ? { ...current, report } : { kind: "ready", report },
    );
  }, []);

  return { clientRef, state, applyReport };
}

export function ReportRoute() {
  const { backupId, reportId } = useRouteIds();
  const routeState = useRecentRouteState(backupId);

  return (
    <RecentRouteGate
      backupId={backupId}
      description="Build a report from messages stored in the local derived database."
      routeState={routeState}
      title="Report builder"
    >
      {(record) => (
        <ReportBuilderWorkspace
          key={`${record.id}:${reportId}`}
          record={record}
          reportId={reportId}
        />
      )}
    </RecentRouteGate>
  );
}

function ReportBuilderWorkspace({
  record,
  reportId,
}: {
  record: RecentBackupRecord;
  reportId: string;
}) {
  const navigate = useNavigate();
  const { clientRef, state, applyReport } = useReportData(record.id, reportId);
  const [title, setTitle] = useState("");
  const [matter, setMatter] = useState("");
  const [preparer, setPreparer] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [items, setItems] = useState<EditableReportItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const timezones = useMemo(() => supportedTimezones(timezone), [timezone]);

  useEffect(() => {
    if (state.kind !== "ready") {
      return;
    }
    setTitle(state.report.title);
    setMatter(state.report.caseMetadata.matter);
    setPreparer(state.report.caseMetadata.preparer);
    setTimezone(state.report.caseMetadata.timezone);
    setItems(state.report.items.map((item) => ({ item, note: item.note })));
  }, [state]);

  const save = async (openPrint: boolean) => {
    if (state.kind !== "ready" || saving) {
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    setSaveMessage(undefined);
    try {
      const client = (clientRef.current ??= createDbWorkerClient());
      const result = await client.api.saveReport({
        backupId: record.id,
        reportId,
        title,
        caseMetadata: { matter, preparer, timezone },
        items: items.map(({ item, note }) => ({
          messageId: item.message.id,
          note,
        })),
      });
      if (!result.ok) {
        setSaveError(formatWorkerResultError(result.error));
        return;
      }
      setSaveMessage("Report changes saved locally.");
      if (openPrint) {
        void navigate(
          `/backup/${encodeURIComponent(record.id)}/report/${encodeURIComponent(reportId)}/print`,
        );
      } else {
        applyReport(result.value);
      }
    } catch (cause) {
      setSaveError(formatError(cause));
    } finally {
      setSaving(false);
    }
  };

  const deleteReport = async () => {
    if (deleting) {
      return;
    }
    setDeleting(true);
    try {
      const client = (clientRef.current ??= createDbWorkerClient());
      const result = await client.api.deleteReport({ backupId: record.id, reportId });
      if (!result.ok) {
        setSaveError(formatWorkerResultError(result.error));
        setDeleteOpen(false);
        return;
      }
      void navigate(`/backup/${encodeURIComponent(record.id)}/messages`);
    } catch (cause) {
      setSaveError(formatError(cause));
      setDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  if (state.kind !== "ready") {
    return <ReportLoadShell record={record} state={state} />;
  }

  return (
    <PageShell
      actions={
        <>
          <Button asChild size="sm" variant="ghost">
            <Link to={`/backup/${encodeURIComponent(record.id)}/messages`}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              Messages
            </Link>
          </Button>
          <Button
            disabled={saving}
            onClick={() => {
              void save(false);
            }}
            size="sm"
            variant="secondary"
          >
            <Save aria-hidden="true" className="size-4" />
            Save report
          </Button>
          <Button
            disabled={saving || items.length === 0}
            onClick={() => {
              void save(true);
            }}
            size="sm"
            variant="primary"
          >
            <FileText aria-hidden="true" className="size-4" />
            Prepare print view
          </Button>
        </>
      }
      description="Order selected messages, add item notes and case metadata, then prepare a source-verified print view."
      eyebrow="Report builder"
      maxWidth="full"
      title={state.report.title}
    >
      {saveMessage === undefined ? null : (
        <p className="rounded-md bg-[var(--success-subtle)] p-3 text-caption text-[var(--success-foreground)]" role="status">
          {saveMessage}
        </p>
      )}
      {saveError === undefined ? null : (
        <p className="rounded-md bg-danger-subtle p-3 text-caption text-danger" role="alert">
          {saveError}
        </p>
      )}

      <div className="grid gap-6 [grid-template-columns:minmax(0,1fr)_minmax(var(--pane-report-meta),0.55fr)]">
        <Panel>
          <PanelHeader
            badge={<Badge variant="neutral">{items.length.toLocaleString()} items</Badge>}
            description="Items print in this order. Source timestamps and identifiers are preserved."
            title="Report items"
          />
          {items.length === 0 ? (
            <EmptyState
              action={
                <Button asChild variant="primary">
                  <Link to={`/backup/${encodeURIComponent(record.id)}/messages`}>
                    Add messages
                  </Link>
                </Button>
              }
              icon={<MessageSquareText aria-hidden="true" className="size-6" />}
            >
              No messages are selected for this report.
            </EmptyState>
          ) : (
            <ol className="mt-4 grid gap-4">
              {items.map((editable, index) => (
                <li
                  className="break-inside-avoid rounded-lg border border-border bg-surface-sunken p-4"
                  key={editable.item.message.id}
                >
                  <div className="flex items-start justify-between gap-4">
                    <ReportMessageContent
                      item={editable.item}
                      timezone={timezone}
                    />
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        aria-label={`Move item ${String(index + 1)} up`}
                        disabled={index === 0}
                        onClick={() => {
                          setItems((current) => moveItem(current, index, index - 1));
                        }}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <ArrowUp aria-hidden="true" className="size-4" />
                      </Button>
                      <Button
                        aria-label={`Move item ${String(index + 1)} down`}
                        disabled={index === items.length - 1}
                        onClick={() => {
                          setItems((current) => moveItem(current, index, index + 1));
                        }}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <ArrowDown aria-hidden="true" className="size-4" />
                      </Button>
                      <Button
                        aria-label={`Remove item ${String(index + 1)} from report`}
                        onClick={() => {
                          setItems((current) =>
                            current.filter((_, candidate) => candidate !== index),
                          );
                        }}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                      </Button>
                    </div>
                  </div>
                  <label className="mt-4 block text-caption font-[var(--font-weight-strong)] text-text">
                    Item note
                    <textarea
                      className="mt-2 min-h-[calc(var(--space-64)_+_var(--space-16))] w-full resize-y rounded-md border border-border-strong bg-surface-sunken px-3 py-2 text-body text-text"
                      maxLength={maxReportNoteLength}
                      onChange={(event) => {
                        const note = event.currentTarget.value;
                        setItems((current) =>
                          current.map((candidate, candidateIndex) =>
                            candidateIndex === index ? { ...candidate, note } : candidate,
                          ),
                        );
                      }}
                      value={editable.note}
                    />
                  </label>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <div className="grid content-start gap-6">
          <Panel>
            <PanelHeader
              description="These fields identify the party-prepared exhibit."
              title="Case metadata"
            />
            <div className="mt-4 grid gap-4">
              <ReportField label="Report title">
                <input maxLength={maxReportTitleLength} onChange={(event) => { setTitle(event.currentTarget.value); }} required value={title} />
              </ReportField>
              <ReportField label="Matter">
                <input maxLength={maxCaseFieldLength} onChange={(event) => { setMatter(event.currentTarget.value); }} value={matter} />
              </ReportField>
              <ReportField label="Preparer">
                <input maxLength={maxCaseFieldLength} onChange={(event) => { setPreparer(event.currentTarget.value); }} value={preparer} />
              </ReportField>
              <ReportField label="Displayed timezone">
                <select onChange={(event) => { setTimezone(event.currentTarget.value); }} value={timezone}>
                  {timezones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
                </select>
              </ReportField>
              <p className="text-caption text-text-secondary">
                Every rendered timestamp and printed page is explicitly labeled with this timezone.
              </p>
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="Report management" />
            <Button className="mt-4" onClick={() => { setDeleteOpen(true); }} type="button" variant="destructive">
              <Trash2 aria-hidden="true" className="size-4" />
              Delete report
            </Button>
          </Panel>
        </div>
      </div>

      <ConfirmationDialog
        cancelLabel="Keep report"
        confirmLabel={deleting ? "Deleting report" : `Delete ${state.report.title}`}
        onCancel={() => { setDeleteOpen(false); }}
        onConfirm={() => { void deleteReport(); }}
        open={deleteOpen}
        title="Delete report?"
      >
        This removes the report and its notes from local derived storage. Source backup files are not changed.
      </ConfirmationDialog>
    </PageShell>
  );
}

function ReportField({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="grid gap-2 text-caption font-[var(--font-weight-strong)] text-text">
      {label}
      <span className="[&>input]:h-[var(--control-height-lg)] [&>input]:w-full [&>input]:rounded-md [&>input]:border [&>input]:border-border-strong [&>input]:bg-surface-sunken [&>input]:px-3 [&>input]:text-body [&>input]:text-text [&>select]:h-[var(--control-height-lg)] [&>select]:w-full [&>select]:rounded-md [&>select]:border [&>select]:border-border-strong [&>select]:bg-surface-sunken [&>select]:px-3 [&>select]:text-body [&>select]:text-text">
        {children}
      </span>
    </label>
  );
}

export function ReportsRoute() {
  const { id } = useParams<{ id: string }>();
  const backupId = id ?? "";
  const routeState = useRecentRouteState(backupId);

  return (
    <RecentRouteGate
      backupId={backupId}
      description="Browse reports saved for this backup in the local derived database."
      routeState={routeState}
      title="Reports"
    >
      {(record) => <ReportsListWorkspace key={record.id} record={record} />}
    </RecentRouteGate>
  );
}

type ReportListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; reports: DbReportSummary[] };

function ReportsListWorkspace({ record }: { record: RecentBackupRecord }) {
  const clientRef = useRef<DbWorkerClient | undefined>(undefined);
  const [state, setState] = useState<ReportListState>({ kind: "loading" });

  useEffect(() => {
    const active = { current: true };
    const client = (clientRef.current ??= createDbWorkerClient());
    setState({ kind: "loading" });
    void client.api
      .listReports({ backupId: record.id })
      .then((result) => {
        if (!active.current) {
          return;
        }
        if (!result.ok) {
          setState({
            kind: "error",
            message: formatWorkerResultError(result.error),
          });
          return;
        }
        setState({ kind: "ready", reports: result.value.reports });
      })
      .catch((cause: unknown) => {
        if (active.current) {
          setState({ kind: "error", message: formatError(cause) });
        }
      });
    return () => {
      active.current = false;
    };
  }, [record.id]);

  useEffect(
    () => () => {
      clientRef.current?.release();
      clientRef.current = undefined;
    },
    [],
  );

  const messagesPath = `/backup/${encodeURIComponent(record.id)}/messages`;

  return (
    <PageShell
      actions={
        <Button asChild size="sm" variant="ghost">
          <Link to={messagesPath}>
            <ArrowLeft aria-hidden="true" className="size-4" />
            Messages
          </Link>
        </Button>
      }
      description="Reports are stored only in this browser profile's local derived database."
      eyebrow="Reports"
      title={`${record.friendlyName} reports`}
    >
      {state.kind === "loading" ? (
        <EmptyState icon={<Loader2 aria-hidden="true" className="size-6" />}>
          Loading reports.
        </EmptyState>
      ) : state.kind === "error" ? (
        <p className="rounded-md bg-danger-subtle p-3 text-caption text-danger" role="alert">
          {state.message}
        </p>
      ) : state.reports.length === 0 ? (
        <EmptyState
          action={
            <Button asChild variant="primary">
              <Link to={messagesPath}>Browse messages</Link>
            </Button>
          }
          icon={<FileText aria-hidden="true" className="size-6" />}
        >
          No reports yet. Use the Report action on any message to start one.
        </EmptyState>
      ) : (
        <ul aria-label="Saved reports" className="grid gap-3">
          {state.reports.map((report) => (
            <li key={report.id}>
              <Link
                className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 hover:bg-surface-raised"
                to={`/backup/${encodeURIComponent(record.id)}/report/${encodeURIComponent(report.id)}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-body font-[var(--font-weight-strong)] text-text">
                    {report.title}
                  </span>
                  <span className="mt-1 block text-caption text-text-secondary">
                    {report.itemCount.toLocaleString()} {report.itemCount === 1 ? "item" : "items"} / Updated {formatDateTime(report.updatedAt)}
                  </span>
                </span>
                <FileText aria-hidden="true" className="size-5 shrink-0 text-text-secondary" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}

export function PrintReportRoute() {
  const { backupId, reportId } = useRouteIds();
  const routeState = useRecentRouteState(backupId);

  return (
    <RecentRouteGate
      backupId={backupId}
      description="Prepare source provenance and print the report through Chrome."
      routeState={routeState}
      title="Print report"
    >
      {(record) => (
        <PrintReportWorkspace
          key={`${record.id}:${reportId}`}
          record={record}
          reportId={reportId}
        />
      )}
    </RecentRouteGate>
  );
}

function PrintReportWorkspace({ record, reportId }: { record: RecentBackupRecord; reportId: string }) {
  const { state } = useReportData(record.id, reportId);
  const backupClientRef = useRef<BackupWorkerClient | undefined>(undefined);
  const mediaClientRef = useRef<MediaWorkerClient | undefined>(undefined);
  const passwordForm = useBackupPasswordForm();
  const [provenance, setProvenance] = useState<ProvenanceState>({ kind: "idle" });
  const previewUrlsRef = useRef<string[]>([]);

  const clearPreviewUrls = useCallback(() => {
    previewUrlsRef.current.forEach((url) => {
      URL.revokeObjectURL(url);
    });
    previewUrlsRef.current = [];
  }, []);

  useEffect(() => () => {
    clearPreviewUrls();
    backupClientRef.current?.release();
    mediaClientRef.current?.release();
  }, [clearPreviewUrls]);

  const prepare = useCallback(async (requestPermission: boolean) => {
    if (state.kind !== "ready") {
      return;
    }
    setProvenance({ kind: "loading", label: "Checking source backup access." });
    try {
      const permission = await ensureRecentBackupDirectoryPermission(record, { request: requestPermission });
      if (permission !== "granted") {
        setProvenance({ kind: "needs-permission" });
        return;
      }
      if (record.isEncrypted) {
        setProvenance({ kind: "needs-password" });
        passwordForm.focusAfterFrame();
        return;
      }
      await prepareAttachmentProvenance({
        backupClientRef,
        clearPreviewUrls,
        mediaClientRef,
        onState: setProvenance,
        record,
        report: state.report,
        previewUrlsRef,
      });
    } catch (cause) {
      setProvenance({ kind: "error", message: formatError(cause) });
    }
  }, [clearPreviewUrls, passwordForm, record, state]);

  useEffect(() => {
    if (state.kind === "ready" && provenance.kind === "idle") {
      void prepare(false);
    }
  }, [prepare, provenance.kind, state.kind]);

  // The @page margin boxes in global.css resolve custom properties from the
  // page context, which inherits from the ROOT element only — variables set
  // on a nested element never reach the printed running header/footer, so
  // stamp them on documentElement while this route is mounted.
  useEffect(() => {
    if (state.kind !== "ready") {
      return;
    }
    const root = document.documentElement;
    const exportedAt =
      provenance.kind === "ready"
        ? provenance.exportTimestamp
        : new Date().toISOString();
    root.style.setProperty(
      "--report-print-title",
      `"${escapeCssContent(state.report.title)}"`,
    );
    root.style.setProperty(
      "--report-print-footer",
      `"Exported ${exportedAt} UTC / ${escapeCssContent(state.report.caseMetadata.timezone)}"`,
    );
    return () => {
      root.style.removeProperty("--report-print-title");
      root.style.removeProperty("--report-print-footer");
    };
  }, [provenance, state]);

  const unlockAndPrepare = async () => {
    const client = (backupClientRef.current ??= createBackupWorkerClient());
    setProvenance({ kind: "loading", label: "Checking the backup password." });
    let unlocked = false;
    try {
      const result = await passwordForm.submitWithPassword(
        async (password) =>
          client.api.unlockBackupSession(
            record.directoryHandle,
            { backupId: record.id, password },
            proxiedWorkerProgress((progress) => {
              setProvenance({ kind: "loading", label: progress.label });
            }),
          ),
        { emptyPasswordMessage: "Enter the backup password before preparing the report." },
      );
      if (!result.ok) {
        setProvenance({ kind: "error", message: formatWorkerResultError(result.error) });
        return;
      }
      unlocked = true;
      if (state.kind !== "ready") {
        return;
      }
      await prepareAttachmentProvenance({
        backupClientRef,
        clearPreviewUrls,
        mediaClientRef,
        onState: setProvenance,
        record,
        report: state.report,
        previewUrlsRef,
      });
    } catch (cause) {
      setProvenance({ kind: "error", message: formatError(cause) });
      passwordForm.focusAfterFrame();
    } finally {
      // The explicit post-read lock must run on every path that unlocked the
      // session, including preparation failures and stale-state early
      // returns; terminating the route worker is the secure fallback when
      // the lock RPC itself fails.
      if (unlocked) {
        try {
          await client.api.lockBackupSession();
        } catch {
          client.release();
          backupClientRef.current = undefined;
        }
      }
    }
  };

  if (state.kind !== "ready") {
    return <ReportLoadShell record={record} state={state} />;
  }

  const exportTimestamp =
    provenance.kind === "ready" ? provenance.exportTimestamp : new Date().toISOString();
  const attachmentProvenance = provenance.kind === "ready" ? provenance.attachments : [];

  return (
    <main
      className="report-print-root mx-auto w-full max-w-[var(--layout-content-wide)] px-6 py-8 print:max-w-none print:p-0"
      id="main-content"
      tabIndex={-1}
    >
      <div className="report-print-toolbar mb-6 flex items-start justify-between gap-6 rounded-lg border border-border bg-surface p-4 shadow-1 print:hidden">
        <div>
          <p className="text-micro text-accent-text">Print report</p>
          <h1 className="mt-2 text-title text-text">{state.report.title}</h1>
          <p className="mt-2 text-body text-text-secondary">
            Source attachment hashes are prepared locally before Chrome opens the print dialog.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button asChild variant="ghost">
            <Link to={`/backup/${encodeURIComponent(record.id)}/report/${encodeURIComponent(reportId)}`}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              Builder
            </Link>
          </Button>
          <Button
            disabled={provenance.kind !== "ready"}
            onClick={() => {
              window.print();
            }}
            variant="primary"
          >
            <Printer aria-hidden="true" className="size-4" />
            Print to PDF
          </Button>
        </div>
      </div>

      <div className="report-print-toolbar mb-6 print:hidden">
        {provenance.kind === "loading" ? (
          <p className="flex items-center gap-2 rounded-md bg-[var(--info-subtle)] p-3 text-caption text-[var(--info-foreground)]" role="status">
            <Loader2 aria-hidden="true" className="size-4" />{provenance.label}
          </p>
        ) : provenance.kind === "needs-permission" ? (
          <EmptyState
            action={<Button onClick={() => { void prepare(true); }} variant="primary">Grant source access</Button>}
            icon={<FileText aria-hidden="true" className="size-6" />}
          >Chrome needs read access to recompute source attachment hashes for this export.</EmptyState>
        ) : provenance.kind === "needs-password" || (provenance.kind === "error" && record.isEncrypted) ? (
          <BackupPasswordForm
            actions={
              <Button type="submit" variant="primary">
                Unlock and prepare
              </Button>
            }
            controller={passwordForm}
            disclosureLeadIn="The password is used only to prepare this report."
            disabled={false}
            errorDescriptionId="report-password-error"
            inputId="report-backup-password"
            inputSize="lg"
            invalid={provenance.kind === "error"}
            layout="stacked"
            onSubmit={() => { void unlockAndPrepare(); }}
            required
          >
            {provenance.kind === "error" ? (
              <p className="text-caption text-danger" id="report-password-error" role="alert">
                {provenance.message}
              </p>
            ) : null}
          </BackupPasswordForm>
        ) : provenance.kind === "error" ? (
          <p className="rounded-md bg-danger-subtle p-3 text-caption text-danger" role="alert">{provenance.message}</p>
        ) : null}
      </div>

      <article
        className="report-print-document bg-surface text-text"
        data-testid="report-print-view"
      >
        <header className="report-document-title border-b border-border pb-6">
          <p className="text-micro text-text-secondary">{appName} message report</p>
          <h2 className="mt-2 text-title text-text">{state.report.title}</h2>
          <dl className="mt-5 grid grid-cols-3 gap-3">
            <PrintMetadata label="Matter" value={state.report.caseMetadata.matter || "Not provided"} />
            <PrintMetadata label="Preparer" value={state.report.caseMetadata.preparer || "Not provided"} />
            <PrintMetadata label="Displayed timezone" value={state.report.caseMetadata.timezone} />
          </dl>
        </header>

        <section className="mt-8" aria-labelledby="report-messages-heading" data-testid="report-message-transcript">
          <h2 className="text-heading text-text" id="report-messages-heading">Selected message transcript</h2>
          <p className="mt-2 text-caption text-text-secondary">Margin numbers correspond to the message metadata section after the transcript.</p>
          <ol className="report-transcript mt-5 grid list-none gap-5 p-0">
            {state.report.items.map((item, index) => (
              <li
                className={cn(
                  "report-message-item relative break-inside-avoid",
                  item.message.isFromMe ? "report-message-item-sent" : "report-message-item-received",
                )}
                key={item.message.id}
              >
                <span aria-label={`Message ${String(index + 1)}`} className="report-message-number border border-border font-mono">{String(index + 1)}</span>
                <p className={cn("report-conversation-label mb-2 text-micro text-text-secondary", item.message.isFromMe && "text-right")}>{conversationTitle(item.conversation)}</p>
                <PrintMessageBubble item={item} provenance={attachmentProvenance} timezone={state.report.caseMetadata.timezone} />
              </li>
            ))}
          </ol>
        </section>

        <MessageMetadataSection
          attachmentProvenance={attachmentProvenance}
          report={state.report}
        />

        <ProvenanceAppendix
          attachmentProvenance={attachmentProvenance}
          exportTimestamp={exportTimestamp}
          ingestSummary={state.ingestSummary}
          record={record}
          report={state.report}
        />
      </article>
    </main>
  );
}

async function prepareAttachmentProvenance(input: {
  backupClientRef: React.RefObject<BackupWorkerClient | undefined>;
  clearPreviewUrls: () => void;
  mediaClientRef: React.RefObject<MediaWorkerClient | undefined>;
  onState: (state: ProvenanceState) => void;
  previewUrlsRef: React.RefObject<string[]>;
  record: RecentBackupRecord;
  report: DbReport;
}): Promise<void> {
  input.clearPreviewUrls();
  const attachments = uniqueReportAttachments(input.report);
  const results: AttachmentProvenance[] = [];
  const backupClient = (input.backupClientRef.current ??= createBackupWorkerClient());

  for (const [index, attachment] of attachments.entries()) {
    input.onState({
      kind: "loading",
      label: `Verifying source attachment ${String(index + 1)} of ${String(attachments.length)}.`,
    });
    if (attachment.sourceDomain === undefined || attachment.sourcePath === undefined) {
      results.push({ attachment, error: "Source path metadata is unavailable." });
      continue;
    }
    try {
      const read = await backupClient.api.readSourceFile(input.record.directoryHandle, {
        backupId: input.record.id,
        sourceDomain: attachment.sourceDomain,
        sourcePath: attachment.sourcePath,
        ...(attachment.sourceGuid === undefined ? {} : { sourceGuid: attachment.sourceGuid }),
        ...(attachment.sha256 === undefined ? {} : { expectedSha256: attachment.sha256 }),
        ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
        ...(attachment.mime === undefined ? {} : { mime: attachment.mime }),
      });
      if (!read.ok) {
        results.push({ attachment, error: formatWorkerResultError(read.error) });
        continue;
      }
      const previewUrl = await createPrintPreviewUrl(
        read.value,
        attachment,
        input.mediaClientRef,
      );
      if (previewUrl !== undefined) {
        input.previewUrlsRef.current.push(previewUrl);
      }
      results.push({ attachment, response: read.value, ...(previewUrl === undefined ? {} : { previewUrl }) });
    } catch (cause) {
      results.push({ attachment, error: formatError(cause) });
    }
  }

  input.onState({
    kind: "ready",
    attachments: results,
    exportTimestamp: new Date().toISOString(),
  });
}

async function createPrintPreviewUrl(
  source: ReadSourceFileResponse,
  attachment: DbAttachmentSummary,
  mediaClientRef: React.RefObject<MediaWorkerClient | undefined>,
): Promise<string | undefined> {
  if (attachment.mediaKind === "image") {
    return URL.createObjectURL(source.blob);
  }
  if (attachment.mediaKind !== "heic") {
    return undefined;
  }
  const client = (mediaClientRef.current ??= createMediaWorkerClient());
  const thumbnail = await client.api.createAttachmentThumbnail({
    backupId: source.backupId ?? "report",
    blob: source.blob,
    cacheKey: attachment.thumbnailCacheKey,
    mediaKind: attachment.mediaKind,
    ...(attachment.mime === undefined ? {} : { mime: attachment.mime }),
    maxPixelSize: defaultThumbnailMaxPixelSize,
  });
  if (!thumbnail.ok || thumbnail.value.status !== "ok") {
    return undefined;
  }
  // The Blob constructor copies BufferSource parts, so the worker-transferred
  // bytes can be handed over directly without an intermediate copy. Structured
  // clone always yields views over plain ArrayBuffers, so the narrowing cast
  // from Uint8Array<ArrayBufferLike> is sound.
  return URL.createObjectURL(
    new Blob([thumbnail.value.bytes as Uint8Array<ArrayBuffer>], {
      type: thumbnail.value.mime,
    }),
  );
}

function ReportLoadShell({ record, state }: { record: RecentBackupRecord; state: ReportLoadState }) {
  const message =
    state.kind === "loading"
      ? "Loading report."
      : state.kind === "missing"
        ? "This report was not found in the local derived database."
        : state.kind === "error"
          ? state.message
          : "Loading report.";
  return (
    <PageShell
      actions={<Button asChild variant="ghost"><Link to={`/backup/${encodeURIComponent(record.id)}/messages`}><ArrowLeft aria-hidden="true" className="size-4" />Messages</Link></Button>}
      description="The requested report is stored only in this browser profile."
      eyebrow="Report"
      title={state.kind === "loading" ? "Loading report" : "Report unavailable"}
    >
      <EmptyState icon={state.kind === "loading" ? <Loader2 aria-hidden="true" className="size-6" /> : <FileText aria-hidden="true" className="size-6" />}>{message}</EmptyState>
    </PageShell>
  );
}

function ReportMessageContent({ item, timezone }: { item: DbReportItem; timezone: string }) {
  const sender = item.message.sender === undefined
    ? item.message.isFromMe ? "Me" : "Unknown sender"
    : participantLabel(item.message.sender);
  return (
    <div className="min-w-0">
      <p className="text-caption font-[var(--font-weight-strong)] text-text">{sender}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-body text-text">{cleanMessageBody(item.message.body).trim() || "Message without text"}</p>
      <p className="mt-2 text-caption text-text-secondary">{formatReportTimestamp(item.message.sentAtUtc, timezone)} / {timezone}</p>
      {item.message.attachments.length === 0 ? null : <p className="mt-1 text-caption text-text-secondary">{item.message.attachments.map((attachment) => attachment.filename ?? attachment.sourcePath ?? "Attachment").join(", ")}</p>}
    </div>
  );
}

function PrintMessageBubble({ item, provenance, timezone }: { item: DbReportItem; provenance: AttachmentProvenance[]; timezone: string }) {
  const message = item.message;
  const sender = message.sender === undefined ? message.isFromMe ? "Me" : "Unknown sender" : participantLabel(message.sender);
  if (message.isSystemEvent) {
    return (
      <div className="report-system-message text-center text-caption text-text-secondary">
        <p>{cleanMessageBody(message.body).trim() || "System event"}</p>
        <p className="mt-1">{formatReportTimestamp(message.sentAtUtc, timezone)} / {timezone}</p>
      </div>
    );
  }
  return (
    <div className={cn("report-message-stack", message.isFromMe ? "ml-auto items-end" : "mr-auto items-start")}>
      <p className="mb-1 text-caption text-text-secondary">{sender}</p>
      <div className={cn("report-message-bubble rounded-bubble px-4 py-3", message.isFromMe ? message.serviceKind === "sms-family" ? "bg-[var(--bubble-sms)] text-bubble-foreground" : "bg-[var(--bubble-imessage)] text-bubble-foreground" : "border border-border bg-[var(--bubble-received)] text-text")}>
        <PrintBubbleAttachments item={item} provenance={provenance} />
        {cleanMessageBody(message.body).trim().length === 0 ? null : (
          <p className={cn("whitespace-pre-wrap break-words text-body", message.attachments.length > 0 && "mt-2")}>{cleanMessageBody(message.body)}</p>
        )}
      </div>
      {message.edited || message.unsent ? (
        <p className="mt-1 text-caption text-warning">{[message.edited ? "Edited" : undefined, message.unsent ? "Unsent" : undefined].filter(Boolean).join(" / ")}</p>
      ) : null}
      <p className="mt-1 text-caption text-text-secondary">{formatReportTimestamp(message.sentAtUtc, timezone)} / {timezone}</p>
      {message.reactions.length === 0 ? null : (
        <div className="report-message-reactions mt-1 flex flex-wrap gap-2 text-caption text-text-secondary">
          {message.reactions.map((reaction) => (
            <span key={reaction.id}>{reportReactionLabel(reaction.kind)} by {reaction.sender === undefined ? "Unknown" : participantLabel(reaction.sender)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function PrintBubbleAttachments({ item, provenance }: { item: DbReportItem; provenance: AttachmentProvenance[] }) {
  const byId = new Map(provenance.map((entry) => [entry.attachment.id, entry]));
  return (
    <div className="report-attachments grid gap-2">
      {item.message.attachments.map((attachment) => {
        const entry = byId.get(attachment.id);
        return (
          <figure className="break-inside-avoid overflow-hidden rounded-md border border-border bg-surface p-2 text-text" key={attachment.id}>
            {entry?.previewUrl === undefined ? null : <img alt={attachment.filename ?? "Report attachment"} className="max-h-[calc(var(--space-64)_*5)] w-full object-contain" src={entry.previewUrl} />}
            <figcaption className="mt-2 break-all text-caption text-text-secondary">{attachment.filename ?? attachment.sourcePath ?? "Attachment"}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}

function MessageMetadataSection({ attachmentProvenance, report }: { attachmentProvenance: AttachmentProvenance[]; report: DbReport }) {
  const provenanceById = new Map(attachmentProvenance.map((entry) => [entry.attachment.id, entry]));
  return (
    <section className="report-message-metadata mt-10 break-before-page" data-testid="report-message-metadata">
      <h2 className="text-heading text-text">Message metadata</h2>
      <p className="mt-3 text-body text-text">The numbers below correspond to the margin numbers in the selected message transcript.</p>
      <ol className="mt-5 grid list-none gap-5 p-0">
        {report.items.map((item, index) => {
          const message = item.message;
          const sender = message.sender === undefined ? message.isFromMe ? "Me" : "Unknown sender" : participantLabel(message.sender);
          return (
            <li className="report-message-metadata-item break-inside-avoid rounded-md border border-border p-4" key={message.id}>
              <h3 className="text-heading text-text">Message {String(index + 1)}</h3>
              <dl className="mt-3 grid grid-cols-3 gap-3">
                <PrintMetadata label="Conversation" value={conversationTitle(item.conversation)} />
                <PrintMetadata label="Sender" value={sender} />
                <PrintMetadata label="Displayed timestamp" value={`${formatReportTimestamp(message.sentAtUtc, report.caseMetadata.timezone)} / ${report.caseMetadata.timezone}`} />
                <PrintMetadata label="Participants" value={item.conversation.participants.map(participantLabel).join(", ") || "Not present"} />
                <PrintMetadata label="Service" value={message.service ?? message.serviceKind ?? "Not present"} />
                <PrintMetadata label="Message state" value={[message.edited ? "Edited" : undefined, message.unsent ? "Unsent" : undefined, message.isSystemEvent ? "System event" : undefined].filter(Boolean).join(" / ") || "Original"} />
                <PrintMetadata label="Source GUID" value={message.sourceGuid ?? "Not present"} mono />
                <PrintMetadata label="Source row id" value={String(message.sourceRowId)} mono />
                <PrintMetadata label="Raw timestamp" value={message.rawTimestamp} mono />
              </dl>
              {item.note.length === 0 ? null : (
                <div className="report-item-note mt-4 border-t border-border pt-3 text-caption text-text">
                  <span className="font-[var(--font-weight-strong)]">Report note: </span>{item.note}
                </div>
              )}
              {message.attachments.length === 0 ? null : (
                <div className="mt-4 border-t border-border pt-3">
                  <h4 className="text-caption font-[var(--font-weight-strong)] text-text">Attachments</h4>
                  <div className="mt-2 grid gap-3">
                    {message.attachments.map((attachment) => {
                      const entry = provenanceById.get(attachment.id);
                      return (
                        <dl className="report-attachment-metadata grid grid-cols-3 gap-2 font-mono" key={attachment.id}>
                          <PrintMetadata label="File" value={attachment.filename ?? "Not present"} />
                          <PrintMetadata label="Source domain" value={attachment.sourceDomain ?? "Not present"} />
                          <PrintMetadata label="Source path" value={attachment.sourcePath ?? "Not present"} />
                          <PrintMetadata label="Source GUID" value={attachment.sourceGuid ?? "Not present"} />
                          <PrintMetadata label="Plaintext SHA-256" value={entry?.response?.sha256 ?? attachment.sha256 ?? "Unavailable"} />
                          <PrintMetadata label={entry?.response?.isEncrypted ? "Stored ciphertext SHA-256" : "Stored source SHA-256"} value={entry?.response?.sourceSha256 ?? "Unavailable"} />
                        </dl>
                      );
                    })}
                  </div>
                </div>
              )}
              {message.reactions.length === 0 ? null : (
                <div className="mt-4 border-t border-border pt-3">
                  <h4 className="text-caption font-[var(--font-weight-strong)] text-text">Reactions</h4>
                  <ul className="mt-2 grid gap-1 text-caption text-text-secondary">
                    {message.reactions.map((reaction) => (
                      <li key={reaction.id}>{reportReactionLabel(reaction.kind)} by {reaction.sender === undefined ? "Unknown" : participantLabel(reaction.sender)} / source row {String(reaction.sourceRowId)} / raw timestamp {reaction.rawTimestamp}</li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function reportReactionLabel(kind: string): string {
  switch (kind) {
    case "loved": return "Loved";
    case "liked": return "Liked";
    case "disliked": return "Disliked";
    case "laughed": return "Laughed";
    case "emphasized": return "Emphasized";
    case "questioned": return "Questioned";
    default: return "Reacted";
  }
}

function ProvenanceAppendix({ attachmentProvenance, exportTimestamp, ingestSummary, record, report }: { attachmentProvenance: AttachmentProvenance[]; exportTimestamp: string; ingestSummary?: DbIngestSummary; record: RecentBackupRecord; report: DbReport }) {
  const messageDb = ingestSummary?.sourceFiles.find((source) => source.role === "messages-db");
  return (
    <section className="report-provenance-appendix mt-10 break-before-page" data-testid="report-provenance-appendix">
      <h2 className="text-heading text-text">Provenance appendix</h2>
      <p className="mt-3 text-body text-text">This party-prepared report is not a certified forensic examination. Golemine read the iTunes/Finder backup through read-only browser handles, normalized selected Messages records into local derived storage, and re-read included attachment source files at export preparation. The source backup was not modified.</p>
      <h3 className="mt-6 text-heading text-text">Device and backup identity</h3>
      <dl className="mt-3 grid grid-cols-3 gap-3">
        <PrintMetadata label="Device name" value={record.deviceInfo.name ?? "Not present"} />
        <PrintMetadata label="Model" value={record.deviceInfo.model ?? "Not present"} />
        <PrintMetadata label="iOS version" value={record.deviceInfo.osVersion ?? "Not present"} />
        <PrintMetadata label="UDID" value={record.deviceInfo.udid ?? record.id} mono />
        <PrintMetadata label="Serial number" value={record.deviceInfo.serialNumber ?? "Not present"} mono />
        <PrintMetadata label="Phone number" value={record.deviceInfo.phoneNumber ?? "Not present"} />
        <PrintMetadata label="Backup date" value={record.deviceInfo.lastBackupDate ?? "Not present"} />
        <PrintMetadata label="Source folder" value={record.directoryHandle.name} mono />
        <PrintMetadata label="Encrypted backup" value={record.isEncrypted ? "Yes" : "No"} />
      </dl>
      <h3 className="mt-6 text-heading text-text">Source integrity</h3>
      <dl className="mt-3 grid gap-3">
        <PrintMetadata label="sms.db plaintext SHA-256" value={messageDb?.sha256 ?? "Unavailable in ingest provenance"} mono />
        {record.isEncrypted ? <PrintMetadata label="sms.db stored ciphertext SHA-256" value={messageDb?.sourceSha256 ?? "Unavailable in ingest provenance"} mono /> : null}
        {attachmentProvenance.map((entry) => (
          <div className="break-inside-avoid rounded-md border border-border p-3" key={entry.attachment.id}>
            <dt className="text-micro text-text-secondary">Attachment / {entry.attachment.filename ?? entry.attachment.sourcePath ?? entry.attachment.id}</dt>
            {entry.response === undefined ? <dd className="mt-1 text-caption text-text">Hash unavailable: {entry.error ?? "Source was not read."}</dd> : (
              <dd className="mt-2 grid gap-1 font-mono text-caption text-text-secondary">
                <span>Plaintext SHA-256: {entry.response.sha256}</span>
                <span>{entry.response.isEncrypted ? "Stored ciphertext" : "Stored source"} SHA-256: {entry.response.sourceSha256}</span>
                <span>Plaintext bytes: {formatBytes(entry.response.byteLength)} / stored bytes: {formatBytes(entry.response.sourceByteLength)}</span>
              </dd>
            )}
          </div>
        ))}
      </dl>
      <h3 className="mt-6 text-heading text-text">Extraction record</h3>
      <dl className="mt-3 grid grid-cols-3 gap-3">
        <PrintMetadata label="Tool" value={`${appName} ${appVersion}`} />
        <PrintMetadata label="Build commit" value={import.meta.env.VITE_APP_COMMIT ?? "Not supplied"} mono />
        <PrintMetadata label="Export timestamp (UTC)" value={exportTimestamp} />
        <PrintMetadata label="Displayed timezone" value={report.caseMetadata.timezone} />
        <PrintMetadata label="Selected messages" value={String(report.itemCount)} />
        <PrintMetadata label="Open-source code" value="https://github.com/pmeenan/golemine" />
      </dl>
    </section>
  );
}

function PrintMetadata({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) {
  return <div className="break-inside-avoid"><dt className="text-micro text-text-secondary">{label}</dt><dd className={cn("mt-1 break-all text-caption text-text", mono && "font-mono")}>{value}</dd></div>;
}

function uniqueReportAttachments(report: DbReport): DbAttachmentSummary[] {
  const seen = new Set<string>();
  return report.items.flatMap((item) => item.message.attachments).filter((attachment) => {
    if (seen.has(attachment.id)) return false;
    seen.add(attachment.id);
    return true;
  });
}

function moveItem(items: EditableReportItem[], from: number, to: number): EditableReportItem[] {
  if (to < 0 || to >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function supportedTimezones(current: string): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes(current) ? zones : [current, ...zones];
}

// Intl.DateTimeFormat construction is expensive and this formatter runs for
// every item card on every builder re-render; cache one instance per zone.
const reportTimestampFormatters = new Map<string, Intl.DateTimeFormat>();

function getReportTimestampFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = reportTimestampFormatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "long",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
    });
    reportTimestampFormatters.set(timezone, formatter);
  }
  return formatter;
}

function formatReportTimestamp(value: string | undefined, timezone: string): string {
  if (value === undefined) return "Timestamp not present";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return getReportTimestampFormatter(timezone).format(date);
}

function escapeCssContent(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ");
}
