import { useEffect, useMemo, useState } from "react";
import { Cpu, Database, HardDrive, Image as ImageIcon } from "lucide-react";

import { Badge, type BadgeProps } from "../../components/ui/badge";
import {
  createBackupWorkerClient,
  createDbWorkerClient,
  createMediaWorkerClient,
  proxiedWorkerProgress,
} from "../../lib/worker-client";
import {
  formatWorkerErrorPayload,
  type WorkerKind,
  type WorkerProgressEvent,
  type WorkerResult,
} from "../../lib/worker-types";
import { cn } from "../../lib/cn";

type DiagnosticId = "backup" | "db" | "media" | "sqlite";
type DiagnosticState = "idle" | "running" | "passed" | "failed";

interface DiagnosticStatus {
  detail: string;
  state: DiagnosticState;
}

interface DiagnosticItem {
  description: string;
  id: DiagnosticId;
  label: string;
  icon: typeof Cpu;
}

const initialStatuses: Record<DiagnosticId, DiagnosticStatus> = {
  backup: { state: "idle", detail: "Waiting to contact backup-worker." },
  db: { state: "idle", detail: "Waiting to contact db-worker." },
  media: { state: "idle", detail: "Waiting to contact media-worker." },
  sqlite: { state: "idle", detail: "Waiting to open sqlite-wasm in OPFS." },
};

const diagnostics: readonly DiagnosticItem[] = [
  {
    description: "Read-only source access will attach here in M1.",
    icon: HardDrive,
    id: "backup",
    label: "backup-worker",
  },
  {
    description: "Derived DB queries stay behind this worker boundary.",
    icon: Database,
    id: "db",
    label: "db-worker",
  },
  {
    description: "Media decode and thumbnail work will run off the UI thread.",
    icon: ImageIcon,
    id: "media",
    label: "media-worker",
  },
  {
    description: "Creates and queries a tiny opfs-sahpool database.",
    icon: Database,
    id: "sqlite",
    label: "sqlite OPFS",
  },
];

const badgeByState: Record<DiagnosticState, { label: string; variant: BadgeProps["variant"] }> = {
  idle: { label: "Idle", variant: "neutral" },
  running: { label: "Running", variant: "info" },
  passed: { label: "Ready", variant: "success" },
  failed: { label: "Failed", variant: "danger" },
};

export function WorkerDiagnostics() {
  const [statuses, setStatuses] =
    useState<Record<DiagnosticId, DiagnosticStatus>>(initialStatuses);

  const hasFailure = useMemo(
    () => Object.values(statuses).some((status) => status.state === "failed"),
    [statuses],
  );

  useEffect(() => {
    let active = true;
    const backupClient = createBackupWorkerClient();
    const dbClient = createDbWorkerClient();
    const mediaClient = createMediaWorkerClient();

    const setStatus = (id: DiagnosticId, status: DiagnosticStatus) => {
      if (!active) {
        return;
      }

      setStatuses((current) => ({
        ...current,
        [id]: status,
      }));
    };

    const onProgress = (id: DiagnosticId) =>
      proxiedWorkerProgress((event: WorkerProgressEvent) => {
        setStatus(id, {
          state: event.phase === "complete" ? "passed" : "running",
          detail: event.label,
        });
      });

    const runDemo = async (
      id: Exclude<DiagnosticId, "sqlite">,
      worker: WorkerKind,
      run: () => Promise<WorkerResult<{ message: string }>>,
    ) => {
      try {
        setStatus(id, {
          state: "running",
          detail: `Contacting ${worker}-worker.`,
        });

        const result = await run();

        setStatus(id, statusFromResult(result, `${worker}-worker round-trip complete.`));
      } catch (cause) {
        setStatus(id, { state: "failed", detail: summarizeUnknownError(cause) });
      }
    };

    void Promise.all([
      runDemo("backup", "backup", () =>
        backupClient.api.demoRoundTrip(
          { message: "m0-worker-diagnostic", requestId: "m0-backup" },
          onProgress("backup"),
        ),
      ),
      runDemo("db", "db", () =>
        dbClient.api.demoRoundTrip(
          { message: "m0-worker-diagnostic", requestId: "m0-db" },
          onProgress("db"),
        ),
      ),
      runDemo("media", "media", () =>
        mediaClient.api.demoRoundTrip(
          { message: "m0-worker-diagnostic", requestId: "m0-media" },
          onProgress("media"),
        ),
      ),
      runSqliteSmokeDiagnostic(
        dbClient,
        onProgress("sqlite"),
        (status) => {
          setStatus("sqlite", status);
        },
        (cause) => {
          setStatus("sqlite", { state: "failed", detail: summarizeUnknownError(cause) });
        },
      ),
    ]);

    return () => {
      active = false;
      backupClient.release();
      dbClient.release();
      mediaClient.release();
    };
  }, []);

  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-heading text-text">Worker diagnostics</h2>
          <p className="mt-1 text-caption text-text-secondary">
            Browser-run smoke checks for M0 worker boundaries and sqlite-wasm storage.
          </p>
        </div>
        <Badge variant={hasFailure ? "danger" : "accent"}>M0</Badge>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-4">
        {diagnostics.map(({ description, icon: Icon, id, label }) => {
          const status = statuses[id];
          const badge = badgeByState[status.state];

          return (
            <article
              className={cn(
                "flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface-sunken p-4",
                status.state === "passed" && "border-[var(--success)]",
                status.state === "failed" && "border-danger",
              )}
              key={id}
            >
              <div className="flex items-start justify-between gap-3">
                <Icon aria-hidden="true" className="size-5 text-text-tertiary" />
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </div>
              <div className="min-w-0">
                <h3 className="text-body font-[var(--font-weight-strong)] text-text">{label}</h3>
                <p className="mt-1 text-caption text-text-secondary">{description}</p>
                <p className="mt-3 truncate font-mono text-caption text-text-secondary">
                  {status.detail}
                </p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

async function runSqliteSmokeDiagnostic(
  dbClient: ReturnType<typeof createDbWorkerClient>,
  progress: ReturnType<typeof proxiedWorkerProgress>,
  setStatus: (status: DiagnosticStatus) => void,
  setUnexpectedFailure: (cause: unknown) => void,
): Promise<void> {
  try {
    setStatus({
      state: "running",
      detail: "Opening sqlite-wasm with opfs-sahpool.",
    });

    const result = await dbClient.api.runSqliteSmoke(progress);

    setStatus(
      statusFromResult(
        result,
        result.ok
          ? `SQLite ${result.value.sqliteVersion} via ${result.value.vfs}.`
          : "SQLite smoke failed.",
      ),
    );
  } catch (cause) {
    setUnexpectedFailure(cause);
  }
}

function statusFromResult<TValue>(
  result: WorkerResult<TValue>,
  successDetail: string,
): DiagnosticStatus {
  if (result.ok) {
    return { state: "passed", detail: successDetail };
  }

  return { state: "failed", detail: formatWorkerErrorPayload(result.error) };
}

function summarizeUnknownError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
