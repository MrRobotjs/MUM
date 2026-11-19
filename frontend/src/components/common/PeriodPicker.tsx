import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';

// A period dropdown: preset periods, then a "Last [ ] days" box for any whole
// number of days up to max. A typed period shows in the list while chosen.
// 0 is all time.

/** "All time", "Last 24 hours", "Last 6 months", "Last year" or "Last N days". */
export const periodLabel = (days: number) => days === 0 ? 'All time'
  : days === 1 ? 'Last 24 hours'
  : days === 180 ? 'Last 6 months'
  : days === 365 ? 'Last year'
  : `Last ${days} days`;

export function PeriodPicker({ value, onChange, presets, max }: { value: number; onChange: (days: number) => void; presets: readonly number[]; max: number }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const days = /^\d+$/.test(typed) ? Number(typed) : NaN;
  const valid = days >= 1 && days <= max;
  const apply = () => {
    if (!valid) return;
    onChange(days);
    setTyped('');
    setOpen(false);
  };
  return (
    <Select open={open} onOpenChange={setOpen} value={String(value)} onValueChange={next => onChange(Number(next))}>
      <SelectTrigger className="w-auto" aria-label="Period"><SelectValue /></SelectTrigger>
      <SelectContent>
        {presets.map(p => <SelectItem key={p} value={String(p)}>{periodLabel(p)}</SelectItem>)}
        {!presets.includes(value) && <SelectItem value={String(value)}>{periodLabel(value)}</SelectItem>}
        <SelectSeparator />
        {/* Keys stay in the box rather than moving through the list. */}
        <form className="flex items-center gap-2 px-2 py-1.5 text-sm" onKeyDown={e => e.stopPropagation()}
          onSubmit={e => { e.preventDefault(); apply(); }}>
          Last
          <Input type="number" inputMode="numeric" min={1} max={max} step={1} className="h-7 w-20" aria-label="Number of days"
            placeholder="14" value={typed} onChange={e => setTyped(e.target.value)} />
          days
          <Button type="submit" size="sm" variant="outline" className="h-7" disabled={!valid}>Show</Button>
        </form>
      </SelectContent>
    </Select>
  );
}
