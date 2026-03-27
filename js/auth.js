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

  /** Returns a valid access token, prompting sign-in if needed. */
  function getToken() {
    const cached = _getCachedToken();
    if (cached) return Promise.resolve(cached);
    return _requestToken();
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

    // Render the sign-in button using GIS renderButton
    google.accounts.id.initialize({
      client_id: CONFIG.CLIENT_ID,
      callback: _handleCredential,
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

    // Render the GIS button
    google.accounts.id.renderButton(container, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'sign_in_with',
      shape: 'rectangular',
    });

  }

  function _handleCredential(response) {
    // ID token flow — exchange for access token via token client
    if (tokenClient) {
      tokenClient.requestAccessToken({ prompt: '' });
    }
  }

  function _requestToken() {
    return new Promise((resolve) => {
      resolveTokenPromise = resolve;
      if (tokenClient) {
        tokenClient.requestAccessToken({ prompt: '' });
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
