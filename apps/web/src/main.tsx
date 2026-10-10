// first: the e-mail link's parameters are read before the router starts (boot.ts)
import './boot';
import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted type (docs/design.md §1): Geist for Latin, Geist Mono for codes, IBM Plex Sans Arabic for Arabic. The Arabic
// faces carry an Arabic-only unicode-range, so an English session never downloads them.
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-500.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-700.css';
import '@/styles/globals.css';
import '@/lib/i18n';
import { supabase } from '@/lib/supabase';
import { watchPasswordRecovery } from '@/features/auth/password-recovery';
import { App } from '@/app';

// Before the first render: the client reports a password-recovery link while it initialises, which can be before any
// component has subscribed (features/auth/password-recovery.ts).
watchPasswordRecovery(supabase.auth);
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
