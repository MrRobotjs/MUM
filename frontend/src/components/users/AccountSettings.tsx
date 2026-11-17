import { useState, type ReactNode } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo } from '@fortawesome/free-solid-svg-icons';
import { Button } from '../ui/button';
import { CardTitle } from '../ui/card';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import './AccountSettings.css';

// Building blocks for the account page (ACCOUNT_PAGE_DESIGN.md): each section
// is a title, its current state and one action. Explanations open from an (i)
// button, and risky actions confirm in a dialog instead of a checkbox.

// SettingInfo is the (i) button beside a section title.
export function SettingInfo({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="account-info text-muted-foreground" aria-label={`About ${title}`} title={`About ${title}`} onClick={() => setOpen(true)}>
      <FontAwesomeIcon icon={faCircleInfo} aria-hidden="true" />
    </button>
    <ResponsiveDialog open={open} onOpenChange={setOpen} title={title} footer={<Button type="button" variant="outline" onClick={() => setOpen(false)}>Close</Button>}>
      <div className="account-info-body text-sm text-muted-foreground">{children}</div>
    </ResponsiveDialog>
  </>;
}

// SettingHeader lays out a section's title, (i), current state and action.
export function SettingHeader({ title, info, summary, action }: { title: string; info?: ReactNode; summary?: ReactNode; action?: ReactNode }) {
  return <div className="account-setting-head flex flex-wrap items-center gap-3">
    <div className="account-setting-title flex items-center gap-2">
      <CardTitle>{title}</CardTitle>
      {info ? <SettingInfo title={title}>{info}</SettingInfo> : null}
    </div>
    {summary != null && summary !== '' ? <div className="account-setting-summary text-sm text-muted-foreground">{summary}</div> : null}
    {action ? <div className="account-setting-action">{action}</div> : null}
  </div>;
}

// ConfirmAction asks before a risky action. Confirm runs the action once; the
// dialog stays open while it runs, so it cannot be pressed twice.
export function ConfirmAction({ open, onOpenChange, title, children, confirmLabel, busy, destructive, onConfirm, confirmDisabled }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode;
  confirmLabel: string; busy: boolean; destructive?: boolean; onConfirm: () => void;
  // Holds Confirm until fields inside the dialog (such as an audited reason) are valid.
  confirmDisabled?: boolean;
}) {
  return <ResponsiveDialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }} title={title} footer={[
    <Button key="cancel" type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>,
    <Button key="confirm" type="button" variant={destructive ? 'destructive' : 'default'} disabled={busy || confirmDisabled} onClick={onConfirm}>{confirmLabel}</Button>,
  ]}>
    <div className="account-info-body text-sm text-muted-foreground">{children}</div>
  </ResponsiveDialog>;
}

// SettingNotice is a section's last message. A failure offers Try again, which
// only reads the saved state again; nothing is ever retried by itself.
export type Notice = { text: string; error?: boolean } | null;
export function SettingNotice({ notice, busy, onRetry }: { notice: Notice; busy?: boolean; onRetry?: () => void }) {
  if (!notice) return null;
  return <div className="account-setting-error flex flex-wrap items-center gap-3">
    <p className={notice.error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'} role="status">{notice.text}</p>
    {notice.error && onRetry ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRetry}>Try again</Button> : null}
  </div>;
}

// The message shown when a confirmed change no longer matches what was read.
export const changedWhileConfirming = 'This account changed while you were confirming. Check it and try again.';
