import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Ellipsis, GitFork, Unlink, UserMinus, UserPlus, UserRound, Workflow } from 'lucide-react';
import type { OrgChartNodeDto } from '@flowza/contracts';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useOrgChart } from './context';

/**
 * The ⋯ menu of a person — on a chart card and on an Unassigned row alike: everything a drag can do, from the keyboard too
 * (a drag is never the only way), plus "Add direct reports…", which is how a chart with no reporting lines yet gets its first
 * team. A manager the chart's current view does not show (another branch or department) is named as such in the dialogs.
 */
export function PersonMenu({ node, name, className }: { node: OrgChartNodeDto; name: string; className?: string }) {
  const { t } = useTranslation('employees');
  const ctx = useOrgChart();
  const navigate = useNavigate();
  const me = { id: node.id, name };
  // the manager's name is looked up when an item is chosen (it scans the loaded levels), not on every render of every card
  const changeManager = () => {
    const managerName = ctx.managerNameOf(node);
    const outsideManager = node.managerEmployeeId !== null && managerName === null;
    ctx.edit({ kind: 'assign', employeeIds: [node.id], subjectName: name, currentManagerName: managerName, line: 'primary', outsideManagerCount: outsideManager ? 1 : 0 });
  };
  const removable = node.managerEmployeeId !== null || node.secondaryManagerEmployeeId !== null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn('size-7 shrink-0', className)} aria-label={t('orgChart.card.actions', { name })}><Ellipsis /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={changeManager}><Workflow /> {t('orgChart.card.changeManager')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => ctx.edit({ kind: 'assign', employeeIds: [node.id], subjectName: name, line: 'secondary' })}><GitFork /> {t('orgChart.card.setSecondary')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => ctx.edit({ kind: 'addReports', manager: me })}><UserPlus /> {t('orgChart.card.addReports')}</DropdownMenuItem>
        {removable ? <DropdownMenuSeparator /> : null}
        {node.managerEmployeeId ? <DropdownMenuItem destructive onSelect={() => ctx.edit({ kind: 'remove', employee: me, line: 'primary', managerName: ctx.managerNameOf(node) })}><UserMinus /> {t('orgChart.card.removeManager')}</DropdownMenuItem> : null}
        {node.secondaryManagerEmployeeId ? <DropdownMenuItem destructive onSelect={() => ctx.edit({ kind: 'remove', employee: me, line: 'secondary', managerName: node.secondaryManagerName })}><Unlink /> {t('orgChart.card.removeSecondary')}</DropdownMenuItem> : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate(`/employees/${node.id}`)}><UserRound /> {t('orgChart.card.viewProfile')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
