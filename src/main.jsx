import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register the service worker — required for Chrome to treat this as a
// real installable app (and for TWA/APK packaging via PWABuilder).
//
// The path is built from BASE_URL rather than hardcoded as '/sw.js'. On a
// GitHub Pages subpath deploy, '/sw.js' points outside the site, registration
// fails, and the app is silently not installable. The failure is logged for
// the same reason: an empty .catch(() => {}) hid it completely.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((err) => console.error('JUST CHILL: service worker registration failed', err));
  });
}
