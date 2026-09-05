import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/styles/globals.css';
import '@/lib/i18n';
import { App } from '@/app';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
