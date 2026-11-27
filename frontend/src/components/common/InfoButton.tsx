import { useState, type ReactNode } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo } from '@fortawesome/free-solid-svg-icons';
import { Button } from '../ui/button';
import { ResponsiveDialog } from '../ui/responsive-dialog';

// An (i) button beside a title that opens a dialog with more about it: the
// one place for explanations that don't need to sit on the page every visit.
export function InfoButton({ title, label, children }: { title: string; label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const name = label ?? `About ${title.toLowerCase()}`;
  return (
    <>
      <button
        type="button"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        aria-label={name}
        title={name}
        onClick={() => setOpen(true)}
      >
        <FontAwesomeIcon icon={faCircleInfo} className="text-sm" />
      </button>
      <ResponsiveDialog open={open} onOpenChange={setOpen} title={title}
        footer={<Button variant="outline" onClick={() => setOpen(false)}>Close</Button>}>
        <div className="space-y-3 text-sm leading-relaxed">{children}</div>
      </ResponsiveDialog>
    </>
  );
}
