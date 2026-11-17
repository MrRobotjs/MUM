import { cloneElement, useState, type ReactNode } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { getServiceMeta } from '@/config/pluginMetadata';
import { cn } from '@/lib/utils';
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
export function SettingHeader({ title, icon, info, summary, action }: { title: string; icon?: ReactNode; info?: ReactNode; summary?: ReactNode; action?: ReactNode }) {
  return <div className="account-setting-head flex flex-wrap items-center gap-3">
    <div className="account-setting-title flex items-center gap-2">
      {icon}
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

// SettingIcon is the round, tinted icon beside a section title.
export function SettingIcon({ className, children }: { className: string; children: ReactNode }) {
  return <span aria-hidden="true" className={cn('account-setting-icon', className)}>{children}</span>;
}

// ServiceSettingIcon shows a media service's own icon in its own colour.
export function ServiceSettingIcon({ serviceType }: { serviceType?: string }) {
  const meta = getServiceMeta(serviceType);
  return <SettingIcon className={cn(meta.palette?.accent, meta.palette?.accentDark)}>{appendSize(meta.icon)}</SettingIcon>;
}
const appendSize = (icon: ReturnType<typeof getServiceMeta>['icon']) => cloneElement(icon, { className: cn(icon.props.className, 'w-4 h-4') });

// TabHeading opens a settings tab like the settings pages do: an icon, a
// title and one line about it.
export function TabHeading({ icon, title, description }: { icon: IconDefinition; title: string; description: string }) {
  return <div className="flex items-center gap-3">
    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
      <FontAwesomeIcon icon={icon} className="size-5 text-primary" />
    </div>
    <div>
      <h2 className="mb-1 text-xl font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  </div>;
}
