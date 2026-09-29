import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/adm.json';
import ar from '@/locales/ar/adm.json';
import platformEn from '@/locales/en/platform.json';
import platformAr from '@/locales/ar/platform.json';

registerNamespace('adm', en, ar);
// the portal reuses the platform console's dialogs and tables (status, grants, create tenant, plans, health)
registerNamespace('platform', platformEn, platformAr);
