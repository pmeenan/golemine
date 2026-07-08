import {
  ExternalLink,
  HardDriveDownload,
  KeyRound,
  Smartphone,
  Wrench,
} from "lucide-react";
import { Link } from "react-router";

import { PageShell, Panel, PanelHeader } from "../../components/layout/page-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

interface GuideStep {
  detail: string;
  label: string;
}

const iphoneSteps: readonly GuideStep[] = [
  {
    label: "Create or obtain a local Finder or iTunes backup",
    detail:
      "The backup can be made on any Mac or Windows computer. Golemine only needs a local copy of the finished backup folder on the computer running Chrome.",
  },
  {
    label: "Use a computer backup, not iCloud",
    detail:
      "On macOS Catalina or newer, use Finder. On Windows, use Apple Devices or iTunes if Apple Devices is not available. Choose a local computer backup rather than iCloud.",
  },
  {
    label: "Encrypted backups are OK",
    detail:
      "Encrypted iPhone backups preserve more message and account metadata. Golemine will ask for the password later and keeps it in memory only.",
  },
  {
    label: "Move macOS backups out of Library before opening",
    detail:
      "If the backup was created on macOS, copy the specific backup folder from ~/Library/Application Support/MobileSync/Backup/ to a normal folder such as Documents, Desktop, or an external drive. Chrome may not be allowed to read directly from the Library folder.",
  },
  {
    label: "Open the backup folder",
    detail:
      "Use the folder picker or drag the backup folder onto the landing page. The source backup is read-only and is never modified.",
  },
];

const finderSteps: readonly string[] = [
  "Connect the iPhone to the Mac with a cable and trust the computer if prompted.",
  "Open Finder and select the iPhone in the sidebar.",
  'In the General tab, select "Back up all of the data on your iPhone to this Mac."',
  'Select "Encrypt local backup" if you have the password and want the fuller local backup.',
  'Click "Back Up Now" and wait for the backup to finish.',
  "Copy the specific backup folder out of the macOS Library location before opening it in Chrome.",
];

const appleReferenceLinks = [
  {
    href: "https://support.apple.com/en-us/108796",
    label: "Apple: back up with your Mac",
  },
  {
    href: "https://support.apple.com/en-us/108809",
    label: "Apple: locate backup folders",
  },
  {
    href: "https://support.apple.com/en-us/108353",
    label: "Apple: encrypted backups",
  },
  {
    href: "https://support.apple.com/en-us/108967",
    label: "Apple: back up with Windows",
  },
] as const;

export function IphoneGuideRoute() {
  return (
    <PageShell
      description="Prepare or copy a local iPhone backup folder that Golemine can read in Chrome."
      eyebrow="Backup guide"
      maxWidth="text"
      title="iPhone backup guide"
    >
      <Panel>
        <PanelHeader
          badge={<Badge variant="accent">Finder or iTunes</Badge>}
          description="Use a local backup folder. iCloud backups are not opened directly by this app."
          title="Prepare the backup"
        />
        <ol className="mt-4 grid gap-3">
          {iphoneSteps.map((step, index) => (
            <li className="flex gap-3 rounded-md border border-border bg-surface-sunken p-3" key={step.label}>
              <span className="inline-flex size-[var(--control-height-md)] shrink-0 items-center justify-center rounded-full bg-accent-subtle font-mono text-caption text-accent-text">
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-body font-[var(--font-weight-strong)] text-text">
                  {step.label}
                </span>
                <span className="mt-1 block text-caption text-text-secondary">{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel>
        <PanelHeader
          badge={<Badge variant="neutral">Mac</Badge>}
          description="Use Finder on macOS Catalina or newer. Older macOS versions use iTunes instead."
          title="Mac Finder steps"
        />
        <ol className="mt-4 grid gap-2">
          {finderSteps.map((step, index) => (
            <li className="flex gap-3 text-body text-text-secondary" key={step}>
              <span className="font-mono text-caption text-text-tertiary">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel>
        <div className="flex items-start gap-3">
          <span className="inline-flex size-[var(--control-height-lg)] items-center justify-center rounded-lg bg-surface-sunken text-text-tertiary">
            <KeyRound aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-heading text-text">Encrypted backup note</h2>
            <p className="mt-1 text-body text-text-secondary">
              The password is only needed when encrypted-backup ingest lands. It will never
              be saved, uploaded, or written to derived storage.
            </p>
          </div>
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          badge={<Badge variant="info">Apple Support</Badge>}
          description="These external references are useful for current screenshots and Apple-specific troubleshooting."
          title="Official backup references"
        />
        <ul className="mt-4 grid gap-2">
          {appleReferenceLinks.map((reference) => (
            <li key={reference.href}>
              <a
                className="inline-flex items-center gap-1.5 text-body text-accent-text underline-offset-4 hover:underline"
                href={reference.href}
                rel="noreferrer"
                target="_blank"
              >
                {reference.label}
                <ExternalLink aria-hidden="true" className="size-4" />
              </a>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="flex justify-end">
        <Button asChild variant="primary">
          <Link to="/">
            <HardDriveDownload aria-hidden="true" className="size-4" />
            Open backup
          </Link>
        </Button>
      </div>
    </PageShell>
  );
}

export function AndroidGuideRoute() {
  return (
    <PageShell
      description="Android backup support is planned for a later provider milestone."
      eyebrow="Backup guide"
      maxWidth="text"
      title="Android backup guide"
    >
      <Panel>
        <div className="flex items-start gap-3">
          <span className="inline-flex size-[var(--control-height-lg)] items-center justify-center rounded-lg bg-surface-sunken text-text-tertiary">
            <Smartphone aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-heading text-text">Future provider</h2>
              <Badge variant="info">Later</Badge>
            </div>
            <p className="mt-1 text-body text-text-secondary">
              Golemine's M1 opening flow recognizes iPhone Finder and iTunes backups.
              Android formats remain in the backlog until the provider shape is decided.
            </p>
          </div>
        </div>
      </Panel>

      <Panel>
        <div className="flex items-start gap-3">
          <span className="inline-flex size-[var(--control-height-lg)] items-center justify-center rounded-lg bg-surface-sunken text-text-tertiary">
            <Wrench aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-heading text-text">Current recommendation</h2>
            <p className="mt-1 text-body text-text-secondary">
              Keep Android evidence in its original export location and wait for the Android
              provider milestone before importing it into Golemine.
            </p>
          </div>
        </div>
      </Panel>
    </PageShell>
  );
}
