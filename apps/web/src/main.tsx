// first: the e-mail link's parameters are read before the router starts (boot.ts)
import './boot';
import React from 'react';
import ReactDOM from 'react-dom/client';
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
