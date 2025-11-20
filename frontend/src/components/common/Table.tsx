import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type Column<T> = {
  key: string;
  header: string | ReactNode;
  render?: (row: T, index: number) => ReactNode;
  sortable?: boolean;
  className?: string;
};

export type TableProps<T> = {
  data: T[];
  columns: Column<T>[];
  keyExtractor: (row: T, index: number) => string | number;
  onRowClick?: (row: T, index: number) => void;
  loading?: boolean;
  emptyMessage?: string;
  className?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  zebra?: boolean;
  hoverable?: boolean;
  pinFirstColumn?: boolean;
  sortColumn?: string | null;
  sortDirection?: 'asc' | 'desc';
  onSort?: (column: string) => void;
};

export const Table = <T,>({
  data,
  columns,
  keyExtractor,
  onRowClick,
  loading = false,
  emptyMessage = 'No data available',
  className,
  size = 'md',
  zebra = false,
  hoverable = true,
  pinFirstColumn = false,
  sortColumn,
  sortDirection,
  onSort,
}: TableProps<T>) => {
  const tableClasses = cn(
    'table',
    {
      'table-xs': size === 'xs',
      'table-sm': size === 'sm',
      'table-md': size === 'md',
      'table-lg': size === 'lg',
      'table-zebra': zebra,
      'table-pin-rows': true,
      'table-pin-cols': pinFirstColumn,
    },
    className
  );

  const handleHeaderClick = (column: Column<T>) => {
    if (column.sortable && onSort) {
      onSort(column.key);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="loading loading-spinner loading-lg"></span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className={tableClasses}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={cn(column.className, {
                  'cursor-pointer select-none': column.sortable,
                })}
                onClick={() => handleHeaderClick(column)}
              >
                <div className="flex items-center gap-2">
                  {column.header}
                  {column.sortable && sortColumn === column.key && (
                    <span className="text-xs">
                      {sortDirection === 'asc' ? '↑' : '↓'}
                    </span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, index) => (
            <tr
              key={keyExtractor(row, index)}
              className={cn({
                hover: hoverable,
                'cursor-pointer': !!onRowClick,
              })}
              onClick={() => onRowClick?.(row, index)}
            >
              {columns.map((column) => (
                <td key={column.key} className={column.className}>
                  {column.render
                    ? column.render(row, index)
                    : String((row as Record<string, unknown>)[column.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
