import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTableCellsLarge, faList, faChevronDown } from '@fortawesome/free-solid-svg-icons';

interface ViewToggleProps {
  view: 'table' | 'cards';
  onChange: (view: 'table' | 'cards') => void;
}

export const ViewToggle = ({ view, onChange }: ViewToggleProps) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" type="button" className="gap-2">
          <FontAwesomeIcon icon={view === 'cards' ? faTableCellsLarge : faList} />
          View
          <FontAwesomeIcon icon={faChevronDown} className="text-xs" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => onChange('table')}>
          <FontAwesomeIcon icon={faList} className="mr-2" />
          Table View
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange('cards')}>
          <FontAwesomeIcon icon={faTableCellsLarge} className="mr-2" />
          Card View
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
