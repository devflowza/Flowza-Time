import * as React from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type RowSelectionState, type VisibilityState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button, Checkbox, DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger, EmptyState, ErrorState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';

export interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[] | undefined;
  total: number | undefined;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  sort?: string;
  order?: 'asc' | 'desc';
  onSort?: (columnId: string) => void;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Row selection (bulk actions). Row ids come from getRowId. */
  getRowId?: (row: T) => string;
  selection?: RowSelectionState;
  onSelectionChange?: (next: RowSelectionState) => void;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
  toolbar?: React.ReactNode;
  bulkActions?: (selectedIds: string[]) => React.ReactNode;
  storageKey?: string; // column visibility persistence
  className?: string;
  /** Optional compact card renderer for narrow screens. */
  renderCard?: (row: T) => React.ReactNode;
}

/**
 * Server-driven table (§58): pagination, sorting and filtering happen on the API; this component only renders one page,
 * manages selection and column visibility, and degrades to cards under 768px when a card renderer is provided.
 */
export function DataTable<T>({ columns, data, total, page, pageSize, onPageChange, onPageSizeChange, sort, order, onSort, isLoading, error, onRetry, getRowId, selection, onSelectionChange, onRowClick, emptyTitle, emptyDescription, emptyAction, toolbar, bulkActions, storageKey, className, renderCard }: DataTableProps<T>) {
  const { t } = useTranslation();
  const [visibility, setVisibility] = React.useState<VisibilityState>(() => {
    if (!storageKey) return {};
    try { return JSON.parse(localStorage.getItem(`flowza.table.${storageKey}`) ?? '{}') as VisibilityState; } catch { return {}; }
  });
  React.useEffect(() => { if (storageKey) try { localStorage.setItem(`flowza.table.${storageKey}`, JSON.stringify(visibility)); } catch { /* ignore */ } }, [visibility, storageKey]);

  const selectable = !!onSelectionChange;
  const allColumns = React.useMemo<ColumnDef<T, unknown>[]>(() => {
    if (!selectable) return columns;
    const selectCol: ColumnDef<T, unknown> = {
      id: '__select',
      enableHiding: false,
      header: ({ table }) => <Checkbox aria-label="Select all" checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? 'indeterminate' : false} onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)} />,
      cell: ({ row }) => <Checkbox aria-label="Select row" checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} onClick={(e) => e.stopPropagation()} />,
      size: 32,
    };
    return [selectCol, ...columns];
  }, [columns, selectable]);

  const table = useReactTable({
    data: data ?? [],
    columns: allColumns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
    state: { rowSelection: selection ?? {}, columnVisibility: visibility },
    onRowSelectionChange: (updater) => { if (!onSelectionChange) return; onSelectionChange(typeof updater === 'function' ? updater(selection ?? {}) : updater); },
    onColumnVisibilityChange: setVisibility,
    enableRowSelection: selectable,
  });

  const totalPages = Math.max(1, Math.ceil((total ?? 0) / pageSize));
  const selectedIds = Object.keys(selection ?? {}).filter((k) => selection?.[k]);

  return (
    <div className={cn('space-y-3', className)}>
      {(toolbar || storageKey) ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          {storageKey ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline" size="sm"><Columns3 /> <span className="hidden sm:inline">Columns</span></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>Columns</DropdownMenuLabel>
                {table.getAllLeafColumns().filter((c) => c.getCanHide()).map((c) => (
                  <DropdownMenuCheckboxItem key={c.id} checked={c.getIsVisible()} onCheckedChange={(v) => c.toggleVisibility(!!v)}>{typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}</DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
      {selectedIds.length > 0 && bulkActions ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-accent/60 px-3 py-2 text-sm" role="status">
          <span className="font-medium">{t('common.selected', { count: selectedIds.length })}</span>
          <div className="flex flex-wrap items-center gap-2 ms-auto">{bulkActions(selectedIds)}</div>
        </div>
      ) : null}
      <div className="rounded-lg border bg-card shadow-card">
        {error ? <div className="p-4"><ErrorState error={error} onRetry={onRetry} /></div>
          : isLoading && !data ? <TableSkeleton cols={Math.min(columns.length, 6)} />
          : data && data.length === 0 ? <div className="p-4"><EmptyState icon={Inbox} title={emptyTitle ?? t('common.noResults')} description={emptyDescription ?? t('common.noResultsHint')} action={emptyAction} /></div>
          : (
            <>
              {renderCard ? <div className="divide-y md:hidden">{table.getRowModel().rows.map((row) => <div key={row.id} className="p-3" onClick={() => onRowClick?.(row.original)}>{renderCard(row.original)}</div>)}</div> : null}
              <div className={cn(renderCard && 'hidden md:block')}>
                <Table>
                  <TableHeader>
                    {table.getHeaderGroups().map((hg) => (
                      <TableRow key={hg.id} className="hover:bg-transparent">
                        {hg.headers.map((h) => {
                          const canSort = !!onSort && h.column.columnDef.enableSorting !== false && h.id !== '__select' && h.id !== 'actions';
                          const active = sort === h.id;
                          return (
                            <TableHead key={h.id} style={{ width: h.getSize() !== 150 ? h.getSize() : undefined }}>
                              {h.isPlaceholder ? null : canSort ? (
                                <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => onSort(h.id)} aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
                                  {flexRender(h.column.columnDef.header, h.getContext())}
                                  {active ? (order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ArrowUpDown className="size-3 opacity-40" />}
                                </button>
                              ) : flexRender(h.column.columnDef.header, h.getContext())}
                            </TableHead>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableHeader>
                  <TableBody className={cn(isLoading && 'opacity-60')}>
                    {table.getRowModel().rows.map((row) => (
                      <TableRow key={row.id} data-state={row.getIsSelected() ? 'selected' : undefined} className={cn(onRowClick && 'cursor-pointer')} onClick={() => onRowClick?.(row.original)}>
                        {row.getVisibleCells().map((cell) => <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
      </div>
      <div className="flex flex-col items-center justify-between gap-2 text-sm text-muted-foreground sm:flex-row">
        <div className="flex items-center gap-2">
          <span>{t('common.rowsPerPage')}</span>
          <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
            <SelectTrigger className="h-8 w-[76px]"><SelectValue /></SelectTrigger>
            <SelectContent>{[10, 25, 50, 100].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
          </Select>
          {total !== undefined ? <span className="tnum">{t('common.results', { count: total })}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>{t('common.previous')}</Button>
          <span className="tnum">{t('common.pageOf', { page, total: totalPages })}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>{t('common.next')}</Button>
        </div>
      </div>
    </div>
  );
}
