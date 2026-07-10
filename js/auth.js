/**
 * auth.js — Google Identity Services OAuth 2.0 (implicit / token flow)
 *
 * Uses the GIS tokenClient to get an access token with
 * spreadsheets.readonly scope. The token is cached in sessionStorage
 * so re-auth is only needed once per browser session (or on expiry).
 */

const auth = (() => {
  const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const TOKEN_KEY = 'gsi_access_token';
  const TOKEN_EXP_KEY = 'gsi_token_exp';

  let tokenClient = null;
  let resolveTokenPromise = null;
  let pendingTokenPromise = null;

  // ── Public API ──────────────────────────────────────────────────────

  function init() {
    // Wait for GIS library to load (loaded async in index.html)
    const waitForGis = setInterval(() => {
      if (window.google && window.google.accounts) {
        clearInterval(waitForGis);
        _initTokenClient();
      }
    }, 100);
  }

  /**
   * Returns a valid access token, prompting sign-in if needed.
   * Concurrent callers (parallel sheet fetches) share one in-flight
   * request — otherwise each call would overwrite resolveTokenPromise
   * and every caller but the last would hang forever.
   */
  function getToken() {
    const cached = _getCachedToken();
    if (cached) return Promise.resolve(cached);
    if (!pendingTokenPromise) {
      pendingTokenPromise = _requestToken().finally(() => { pendingTokenPromise = null; });
    }
    return pendingTokenPromise;
  }

  function signOut() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_EXP_KEY);
    document.getElementById('app').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    google.accounts.oauth2.revoke(_getCachedToken(), () => {});
  }

  // ── Private ─────────────────────────────────────────────────────────

  function _initTokenClient() {
    if (!CONFIG.CLIENT_ID || CONFIG.CLIENT_ID.startsWith('YOUR_')) {
      _showConfigError();
      return;
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: SCOPE,
      callback: (response) => {
        if (response.error) {
          console.error('OAuth error:', response.error);
          if (resolveTokenPromise) {
            resolveTokenPromise(null);
            resolveTokenPromise = null;
          }
          return;
        }
        // Cache token
        const exp = Date.now() + (response.expires_in - 60) * 1000;
        sessionStorage.setItem(TOKEN_KEY, response.access_token);
        sessionStorage.setItem(TOKEN_EXP_KEY, exp.toString());

        // Show app
        _onSignedIn(response.access_token);

        if (resolveTokenPromise) {
          resolveTokenPromise(response.access_token);
          resolveTokenPromise = null;
        }
      },
    });

    // Try silent auth first (if already signed in)
    const cached = _getCachedToken();
    if (cached) {
      _onSignedIn(cached);
    } else {
      _renderSignInButton();
    }
  }

  function _renderSignInButton() {
    const container = document.getElementById('google-signin-btn');
    container.innerHTML = '';

    // Single direct button — triggers tokenClient popup on user gesture,
    // which works reliably on both desktop and mobile browsers.
    const btn = document.createElement('button');
    btn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:10px',
      'background:#fff', 'color:#3c4043', 'border:1px solid #dadce0',
      'border-radius:4px', 'padding:10px 24px', 'font-size:15px',
      'font-family:Google Sans,Roboto,sans-serif', 'font-weight:500',
      'cursor:pointer', 'box-shadow:0 1px 3px rgba(0,0,0,.12)',
      'transition:box-shadow .2s',
    ].join(';');
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z"/></svg>
      Sign in with Google`;
    btn.onclick = () => tokenClient && tokenClient.requestAccessToken({ prompt: 'select_account' });
    container.appendChild(btn);
  }

  function _requestToken() {
    return new Promise((resolve) => {
      resolveTokenPromise = resolve;
      if (tokenClient) {
        tokenClient.requestAccessToken({ prompt: 'select_account' });
      } else {
        resolve(null);
      }
    });
  }

  function _getCachedToken() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const exp = parseInt(sessionStorage.getItem(TOKEN_EXP_KEY) || '0', 10);
    if (token && Date.now() < exp) return token;
    return null;
  }

  function _onSignedIn(token) {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    // Fetch user info to display name
    fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((info) => {
        const nameEl = document.getElementById('user-name');
        if (nameEl && info.name) nameEl.textContent = info.name;
      })
      .catch(() => {});

    // Bootstrap the app
    if (window.app) app.init();
  }

  function _showConfigError() {
    const container = document.getElementById('google-signin-btn');
    container.innerHTML = `
      <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:16px;text-align:left;">
        <strong>⚠️ Setup Required</strong>
        <p style="margin-top:8px;font-size:13px;color:#555;">
          Open <code>config.js</code> and replace <code>YOUR_GOOGLE_OAUTH_CLIENT_ID</code>
          with your actual OAuth 2.0 Client ID from Google Cloud Console.
        </p>
        <p style="margin-top:8px;font-size:12px;color:#777;">
          Steps: Cloud Console → APIs &amp; Services → Credentials → Create OAuth 2.0 Client ID
          (Web application, with <code>http://localhost</code> as an authorised origin).
        </p>
      </div>`;
  }

  return { init, getToken, signOut };
})();
