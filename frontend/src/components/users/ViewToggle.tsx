import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ViewToggleProps {
  view: 'table' | 'cards';
  onChange: (view: 'table' | 'cards') => void;
}

export const ViewToggle = ({ view, onChange }: ViewToggleProps) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" type="button" className="gap-2">
          <i className={`fa-solid ${view === 'cards' ? 'fa-th-large' : 'fa-list'}`} />
          View
          <i className="fa-solid fa-chevron-down text-xs" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => onChange('table')}>
          <i className="fa-solid fa-list mr-2" />
          Table View
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange('cards')}>
          <i className="fa-solid fa-th-large mr-2" />
          Card View
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
