import { useMemo, useState } from 'react';
import {
  columnVisibilityFeature, createSortedRowModel, createTableHook, metaHelper, rowPaginationFeature, rowSelectionFeature, rowSortingFeature, tableFeatures,
  type ColumnVisibilityState, type Updater,
} from '@tanstack/react-table';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSort, faSortDown, faSortUp, faTableColumns } from '@fortawesome/free-solid-svg-icons';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

// MUM's tables share one TanStack Table (v9) setup: the features they use,
// what each column carries, a sortable header and the Select columns menu.
// Each table keeps its own markup and classes; sorting and paging stay on the
// server wherever the server does them (manualSorting/manualPagination).

export type DataColumnMeta = {
  /** The column's name in the Select columns menu; unlabelled columns aren't listed. */
  label?: string;
  headClassName?: string;
  cellClassName?: string;
};

// Small tables sort in the browser (sortedRowModel); tables the server sorts
// set manualSorting and pass the server's order through.
export const dataTableFeatures = tableFeatures({
  rowSortingFeature, rowPaginationFeature, columnVisibilityFeature, rowSelectionFeature,
  sortedRowModel: createSortedRowModel(),
  columnMeta: metaHelper<DataColumnMeta>(),
});

// The sortable heading: its label and the sort icon; a plain label when the
// column doesn't sort.
function SortButton() {
  const header = useHeaderContext();
  const label = <header.FlexRender />;
  if (!header.column.getCanSort()) return label;
  const sorted = header.column.getIsSorted();
  return <button type="button" className="inline-flex items-center font-medium" onClick={header.column.getToggleSortingHandler()}>
    {label}
    <FontAwesomeIcon icon={sorted === 'asc' ? faSortUp : sorted === 'desc' ? faSortDown : faSort} className="ml-1 h-3 w-3 opacity-60" />
  </button>;
}

// Select columns: every column with a label, checked when shown; columns that
// can't be hidden are listed but disabled. Unlabelled columns (row controls)
// aren't listed.
function ColumnsMenu() {
  const table = useTableContext();
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="outline" size="sm"><FontAwesomeIcon icon={faTableColumns} />Select columns</Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {table.getAllLeafColumns().filter(column => column.columnDef.meta?.label !== undefined).map(column => <DropdownMenuCheckboxItem key={column.id} checked={column.getIsVisible()} disabled={!column.getCanHide()}
        onCheckedChange={() => column.toggleVisibility()} onSelect={e => e.preventDefault()}>{column.columnDef.meta?.label}</DropdownMenuCheckboxItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

export const { useAppTable, createAppColumnHelper, useTableContext, useHeaderContext } = createTableHook({
  features: dataTableFeatures,
  headerComponents: { SortButton },
  tableComponents: { ColumnsMenu },
});

/** The value an updater produces from the current one. */
export const applyUpdater = <T,>(updater: Updater<T>, current: T): T => typeof updater === 'function' ? (updater as (old: T) => T)(current) : updater;

const readHidden = (key: string, scope: string | undefined, fixed: readonly string[]): string[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    const list = scope === undefined ? stored : (stored as Record<string, unknown> | null)?.[scope];
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && !fixed.includes(id)) : [];
  } catch { return []; }
};
const saveHidden = (key: string, scope: string | undefined, hidden: string[]) => {
  try {
    if (scope === undefined) { localStorage.setItem(key, JSON.stringify(hidden)); return; }
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    const all = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
    localStorage.setItem(key, JSON.stringify({ ...all, [scope]: hidden }));
  } catch { /* not remembered */ }
};

/**
 * Hidden columns remembered per browser under `key`: a list of column ids, or
 * with `scope` one list per scope (such as a server type). `fixed` columns are
 * never hidden. Returns the table's columnVisibility state and its handler.
 */
export function useRememberedColumns(key: string, scope?: string, fixed: readonly string[] = []): [ColumnVisibilityState, (updater: Updater<ColumnVisibilityState>) => void] {
  const [stored, setStored] = useState(() => ({ scope, hidden: readHidden(key, scope, fixed) }));
  const hidden = stored.scope === scope ? stored.hidden : readHidden(key, scope, fixed);
  const signature = hidden.join('\u0001');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visibility = useMemo<ColumnVisibilityState>(() => Object.fromEntries(hidden.map(id => [id, false])), [signature]);
  const onChange = (updater: Updater<ColumnVisibilityState>) => {
    const next = applyUpdater(updater, visibility);
    const list = Object.keys(next).filter(id => next[id] === false && !fixed.includes(id));
    saveHidden(key, scope, list);
    setStored({ scope, hidden: list });
  };
  return [visibility, onChange];
}
