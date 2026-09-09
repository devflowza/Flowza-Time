import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import { useAuth } from './auth-provider';
import { AuthLayout } from './auth-layout';
import { browserTimezone, readPendingOrganization, useCreateOrganization } from './create-organization';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input } from '@/components/ui';

const formSchema = z.object({ displayName: z.string().trim().min(2, 'tooShort').max(120, 'tooLong') });
type Form = z.infer<typeof formSchema>;

/** What a signed-in user with no membership sees instead of the shell: create the organisation, or sign out. */
export function CreateOrganizationScreen() {
  const { t } = useTranslation();
  const { signOut } = useAuth();
  const create = useCreateOrganization();
  const pending = readPendingOrganization();
  const form = useForm<Form>({ resolver: zodResolver(formSchema), defaultValues: { displayName: pending?.displayName ?? '' } });
  const onSubmit = form.handleSubmit(async ({ displayName }) => {
    // mutateAsync so the button stays busy until /me has been refetched; errors are rendered below, not thrown
    await create.mutateAsync({ displayName, timezone: pending?.timezone ?? browserTimezone() }).catch(() => undefined);
  });
  const nameError = form.formState.errors.displayName?.message;
  // A 404 here is not "your organisation was not found": it is an API that does not serve POST /orgs yet (a web
  // deploy ahead of the API deploy). Say so, rather than echoing the router's "Route not found.".
  const describeError = (err: unknown) => {
    if (err instanceof ApiError && err.status === 404) return t('auth.createOrgUnavailable');
    return err instanceof ApiError ? err.message : t('auth.createOrgFailed');
  };
  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t('auth.createOrgTitle')}</CardTitle>
          <CardDescription>{t('auth.createOrgHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <FormField label={t('auth.companyName')} htmlFor="org-name" hint={t('auth.companyNameHint')} error={nameError ? t(nameError === 'tooLong' ? 'auth.companyNameTooLong' : 'auth.companyNameTooShort') : undefined}>
              <Input id="org-name" autoComplete="organization" {...form.register('displayName')} aria-invalid={!!nameError} />
            </FormField>
            {create.error ? <p role="alert" className="text-sm text-destructive">{describeError(create.error)}</p> : null}
            <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>{t('auth.createOrg')}</Button>
            <div className="text-center">
              <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()}>{t('nav.signOut')}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
