import * as React from 'react';
import { cn } from '@/lib/utils';
export const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-x-auto"><table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} /></div>
));
Table.displayName = 'Table';
export const TableHeader = ({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) => <thead className={cn('bg-muted/50 [&_tr]:border-b', className)} {...props} />;
export const TableBody = ({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
export const TableRow = ({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) => <tr className={cn('border-b transition-colors duration-100 hover:bg-muted/50 data-[state=selected]:bg-accent', className)} {...props} />;
export const TableHead = ({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => <th className={cn('h-10 whitespace-nowrap px-3 text-start align-middle text-xs font-medium text-muted-foreground [&:has([role=checkbox])]:pe-0', className)} {...props} />;
export const TableCell = ({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td className={cn('px-3 py-2.5 align-middle [&:has([role=checkbox])]:pe-0', className)} {...props} />;
