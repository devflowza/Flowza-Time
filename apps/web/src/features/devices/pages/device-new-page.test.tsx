import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { DeviceCapabilities, DeviceModelDto, DeviceProviderDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import i18n from '@/lib/i18n';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/devices.json';
import ar from '@/locales/ar/devices.json';
import enSync from '@/locales/en/sync.json';
import arSync from '@/locales/ar/sync.json';
import DeviceNewPage from './device-new-page';

registerNamespace('devices', en, ar);
registerNamespace('sync', enSync, arSync);

const caps: DeviceCapabilities = {
  attendancePull: true, attendancePush: false, employeePush: true, employeePull: false, employeeDelete: false, fingerprint: true, face: false, card: true, pin: true,
  deviceStatus: true, remoteRestart: false, webhooks: false, devicePush: false, biometricTemplatePush: false,
};

/** One provider per vendor — the shape that used to render four one-column grids stacked on top of each other. */
const provider = (key: string, vendor: string, name: string, extra: Partial<DeviceProviderDto> = {}): DeviceProviderDto => ({
  key, vendor, name, description: `Connect ${name} terminals over the local network.`, integrationType: 'ON_PREM_SERVER_API', status: 'available',
  capabilities: caps, configSchema: { fields: [{ key: 'host', label: 'Host', type: 'text', required: true, secret: false }] }, verificationStatus: 'VERIFIED',
  docsUrl: `https://docs.example.test/${key}`, ...extra,
});

/** ZKTeco's real PUSH schema: the serial is a *required config field*, and the wizard asks for it on the details step. */
const PUSH_PROVIDER = provider('zkteco_push', 'ZKTeco', 'ZKTeco PUSH / ADMS protocol', {
  integrationType: 'DEVICE_PUSH',
  configSchema: { fields: [
    { key: 'serialNumber', label: 'Device serial number', type: 'text', required: true, secret: false },
    { key: 'commKey', label: 'Comm key (device menu)', type: 'password', required: false, secret: true },
    { key: 'pushInterval', label: 'Push interval (s)', type: 'number', required: false, secret: false, default: 30 },
  ] },
});

const PROVIDERS = [
  provider('zkteco', 'ZKTeco', 'ZKTeco push SDK'),
  provider('essl', 'eSSL', 'eSSL cloud'),
  provider('fingertec', 'FingerTec', 'FingerTec TCMS'),
  provider('flowza', 'FlowZa', 'FlowZa reference agent', { status: 'placeholder', docsUrl: null }),
];

const MODELS: DeviceModelDto[] = [
  { id: '11111111-1111-4111-a111-111111111111', providerKey: 'zkteco', vendor: 'ZKTeco', model: 'K40', family: 'Standalone', capabilities: { fingerprint: true, card: true }, verification: 'VERIFIED', notes: null },
  { id: '22222222-2222-4222-a222-222222222222', providerKey: 'zkteco', vendor: 'ZKTeco', model: 'MB460', family: 'Face', capabilities: { face: true }, verification: 'REPORTED', notes: null },
];

const renderPage = () => renderWithProviders(<DeviceNewPage />, { route: '/devices/new', path: '/devices/new' });
const radio = (name: RegExp) => screen.getByRole('radio', { name });
const next = () => fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
const pickZkteco = async () => fireEvent.click(await screen.findByRole('radio', { name: /ZKTeco push SDK/ }));

describe('DeviceNewPage', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    mockGet({
      '/device-providers': { data: PROVIDERS },
      '/device-models': { data: MODELS },
      '/orgs/org-1/branches': page([{ id: '33333333-3333-4333-a333-333333333333', organizationId: 'org-1', code: 'HQ', name: 'Muscat HQ', timezone: 'Asia/Muscat', status: 'active' }], 1),
    });
  });

  it('puts every provider in one radio group instead of a single-column grid per vendor', async () => {
    renderPage();
    await screen.findByRole('radio', { name: /ZKTeco push SDK/ });
    // Four vendors used to mean four <section>s, each with its own grid and its own radiogroup — so a
    // `sm:grid-cols-2 xl:grid-cols-3` grid never received a second card to place beside the first.
    const groups = screen.getAllByRole('radiogroup');
    expect(groups).toHaveLength(1);
    expect(within(groups[0]!).getAllByRole('radio')).toHaveLength(PROVIDERS.length);
  });

  it('keeps the provider cards to a single tab stop and moves the selection with the arrow keys', async () => {
    renderPage();
    await screen.findByRole('radio', { name: /ZKTeco push SDK/ });
    // WAI-ARIA APG: a radiogroup is one tab stop. Every card used to be its own.
    expect(screen.getAllByRole('radio').filter((r) => r.tabIndex === 0)).toHaveLength(1);
    // sorted by vendor, so eSSL leads and holds the initial tab stop
    expect(radio(/eSSL cloud/).tabIndex).toBe(0);

    fireEvent.keyDown(radio(/eSSL cloud/), { key: 'ArrowRight' });
    expect(radio(/FingerTec TCMS/)).toHaveAttribute('aria-checked', 'true');
    expect(radio(/FingerTec TCMS/)).toHaveFocus();
    // the placeholder provider cannot be registered, so the arrow keys step over it
    fireEvent.keyDown(radio(/FingerTec TCMS/), { key: 'ArrowRight' });
    expect(radio(/ZKTeco push SDK/)).toHaveAttribute('aria-checked', 'true');
    expect(radio(/FlowZa reference agent/)).toHaveAttribute('aria-checked', 'false');
  });

  it('follows the reading direction with the horizontal arrow keys in ar', async () => {
    await i18n.changeLanguage('ar');
    try {
      renderPage();
      await screen.findByRole('radio', { name: /ZKTeco push SDK/ });
      // In an RTL layout the next card is to the LEFT, so ArrowLeft has to mean "next" — hard-coding ArrowRight
      // reverses the group for every Arabic user.
      fireEvent.keyDown(radio(/eSSL cloud/), { key: 'ArrowLeft' });
      expect(radio(/FingerTec TCMS/)).toHaveAttribute('aria-checked', 'true');
      fireEvent.keyDown(radio(/FingerTec TCMS/), { key: 'ArrowRight' });
      expect(radio(/eSSL cloud/)).toHaveAttribute('aria-checked', 'true');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('offers the model on the same step as the provider, and no longer spends a step on it', async () => {
    renderPage();
    await pickZkteco();
    // Model used to be step 2, reachable only through Next.
    const models = await screen.findByRole('radiogroup', { name: 'Model' });
    expect(within(models).getByRole('radio', { name: /K40/ })).toBeInTheDocument();
    expect(within(models).getByRole('radio', { name: /No specific model/ })).toHaveAttribute('aria-checked', 'true');
    // …and the wizard is four steps, not six: 'Test' folds into 'Connection'.
    const rail = screen.getByRole('navigation', { name: 'Registration steps' });
    expect(within(rail).getAllByRole('listitem')).toHaveLength(4);
    expect(within(rail).queryByRole('button', { name: /^Test/ })).not.toBeInTheDocument();
  });

  it('does not answer a step nobody has reached yet in the rail', async () => {
    renderPage();
    await screen.findByRole('radio', { name: /ZKTeco push SDK/ });
    const rail = screen.getByRole('navigation', { name: 'Registration steps' });
    // With nothing chosen there are no config fields either, and reading `fields.length === 0` as "this provider needs
    // none" made the rail claim an answer for a step the user had not reached.
    expect(within(rail).getByRole('button', { name: /Connection/ })).toHaveTextContent('Not chosen yet');
    expect(within(rail).getByRole('button', { name: /Connection/ })).not.toHaveTextContent('needs no connection settings');
  });

  it('does not nest the documentation link inside a radio', async () => {
    renderPage();
    await pickZkteco();
    const link = await screen.findByRole('link', { name: /Documentation/ });
    // An <a> inside a <button role="radio"> is invalid HTML and unreachable with the arrow keys.
    expect(link.closest('[role="radio"]')).toBeNull();
    expect(link).toHaveAttribute('href', 'https://docs.example.test/zkteco');
  });

  /** A tenant registering its first terminal has no branches yet, and Branch is required to get past this step. */
  it('offers to create a branch when the organisation has none', async () => {
    mockGet({
      '/device-providers': { data: PROVIDERS },
      '/device-models': { data: MODELS },
      '/orgs/org-1/branches': page([], 0),
    });
    renderPage();
    await pickZkteco();
    next();

    fireEvent.click(await screen.findByRole('combobox', { name: /Branch/ }));
    // It used to say "No results" and stop there — with no hint that branches are created under Organisation.
    expect(await screen.findByText('No branches yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add branch/ }));
    expect(await screen.findByRole('heading', { name: 'Add branch' })).toBeInTheDocument();
  });

  it('names an empty required field instead of quoting the validator at the user', async () => {
    renderPage();
    await pickZkteco();
    next();
    await screen.findByLabelText(/^Code/);
    next(); // submit with everything blank

    const alerts = await screen.findAllByRole('alert');
    const messages = alerts.map((a) => a.textContent);
    // Zod's own wording reached the screen: "Invalid GUID" for an unchosen Branch, "Too small: expected string to
    // have >=1 characters" for a blank Code. Nothing in the app installs an error map.
    expect(messages.every((m) => m === 'This field is required')).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps what was typed on the details step when you step back and return', async () => {
    renderPage();
    await pickZkteco();
    next();

    fireEvent.change(await screen.findByLabelText(/^Code/), { target: { value: 'GATE-1' } });
    // The details form used to be owned by the step component, so Back unmounted it and threw the answers away.
    fireEvent.click(screen.getByRole('button', { name: /^Back/ }));
    await screen.findByRole('radio', { name: /ZKTeco push SDK/ });
    next();
    expect(await screen.findByLabelText(/^Code/)).toHaveValue('GATE-1');
  });

  it('reaches review in three moves and lets each group be corrected where it is read', async () => {
    renderPage();
    await pickZkteco();
    next();

    fireEvent.change(await screen.findByLabelText(/^Code/), { target: { value: 'GATE-1' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Main gate' } });
    fireEvent.click(screen.getByRole('combobox', { name: /Branch/ }));
    const opt = await screen.findByText('Muscat HQ');
    fireEvent.click(opt.closest('[cmdk-item]') ?? opt);
    await waitFor(() => expect(screen.getByRole('combobox', { name: /Branch/ })).toHaveTextContent('Muscat HQ'));
    next();

    expect(await screen.findByRole('button', { name: /Test connection/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Host/), { target: { value: 'https://gate.example.test' } });
    next();

    expect(await screen.findByRole('button', { name: /Register device/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Edit —/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: /Edit — Details/ }));
    await waitFor(() => expect(screen.getByLabelText(/^Code/)).toHaveValue('GATE-1'));
  });

  /**
   * The connection step hides `serialNumber` for a push provider because the details step already asked for it — but
   * the step's Next validated the provider's *whole* schema against the config, so the hidden required field failed,
   * the error had nowhere to render, and the button did nothing at all. The serial typed on the details step is the
   * one the provider config wants, so it is carried across.
   */
  it('moves past the connection step for a push device and submits the serial as provider config', async () => {
    mockGet({
      '/device-providers': { data: [...PROVIDERS, PUSH_PROVIDER] },
      '/device-models': { data: MODELS },
      '/orgs/org-1/branches': page([{ id: '33333333-3333-4333-a333-333333333333', organizationId: 'org-1', code: 'HQ', name: 'Muscat HQ', timezone: 'Asia/Muscat', status: 'active' }], 1),
    });
    apiMock.post.mockResolvedValue({ data: { device: { id: 'd9', name: 'Lobby terminal' }, pushToken: null, webhookUrl: null, credentialsStored: [], credentialsError: null, testConnectionJobId: null } });
    renderPage();
    fireEvent.click(await screen.findByRole('radio', { name: /ZKTeco PUSH \/ ADMS protocol/ }));
    next();

    fireEvent.change(await screen.findByLabelText(/^Code/), { target: { value: 'LOBBY-1' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Lobby terminal' } });
    fireEvent.change(screen.getByLabelText(/Serial number/), { target: { value: 'ZK-99887766' } });
    fireEvent.click(screen.getByRole('combobox', { name: /Branch/ }));
    fireEvent.click((await screen.findByText('Muscat HQ')).closest('[cmdk-item]') ?? screen.getByText('Muscat HQ'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: /Branch/ })).toHaveTextContent('Muscat HQ'));
    next();

    // Connection step: nothing here is required — the serial is not even shown, because it was answered already.
    expect(await screen.findByLabelText(/Comm key/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Device serial number/)).not.toBeInTheDocument();
    next();

    fireEvent.click(await screen.findByRole('button', { name: /Register device/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    const [path, body] = apiMock.post.mock.calls[0] as [string, { serialNumber?: string; config: Record<string, unknown> }];
    expect(path).toBe('/orgs/org-1/devices');
    expect(body.serialNumber).toBe('ZK-99887766');
    // The API re-checks the provider schema, so a config without the required serial is a 400 on registration.
    expect(body.config).toMatchObject({ serialNumber: 'ZK-99887766' });
  });

  it('re-validates the details step on the way out, so the rail cannot carry a stale answer to review', async () => {
    renderPage();
    await pickZkteco();
    next();

    fireEvent.change(await screen.findByLabelText(/^Code/), { target: { value: 'GATE-1' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Main gate' } });
    fireEvent.click(screen.getByRole('combobox', { name: /Branch/ }));
    const opt = await screen.findByText('Muscat HQ');
    fireEvent.click(opt.closest('[cmdk-item]') ?? opt);
    await waitFor(() => expect(screen.getByRole('combobox', { name: /Branch/ })).toHaveTextContent('Muscat HQ'));
    next();
    fireEvent.change(await screen.findByLabelText(/^Host/), { target: { value: 'https://gate.example.test' } });
    next();
    await screen.findByRole('button', { name: /Register device/ });

    // back to details through the rail, edit, then leave through the rail without pressing Next
    const rail = screen.getByRole('navigation', { name: 'Registration steps' });
    fireEvent.click(within(rail).getByRole('button', { name: /Details/ }));
    fireEvent.change(await screen.findByLabelText(/^Code/), { target: { value: 'GATE-2' } });

    // an empty required field must not be carried forward at all
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: '' } });
    fireEvent.click(within(rail).getByRole('button', { name: /Review/ }));
    await waitFor(() => expect(screen.getByLabelText(/^Name/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Register device/ })).not.toBeInTheDocument();

    // once it is valid again the snapshot is retaken, so review shows the edit rather than what was submitted before
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Side gate' } });
    fireEvent.click(within(rail).getByRole('button', { name: /Review/ }));
    await screen.findByRole('button', { name: /Register device/ });
    expect(screen.getByText('GATE-2')).toBeInTheDocument();
    expect(screen.getByText('Side gate')).toBeInTheDocument();
    expect(screen.queryByText('GATE-1')).not.toBeInTheDocument();
  });
});
