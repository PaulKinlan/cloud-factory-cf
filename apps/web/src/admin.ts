/**
 * Admin Dashboard & Settings:
 * 1. User Account & BYOK AI Providers (Anthropic, OpenAI, DeepSeek, Gemini).
 * 2. Root System Setup (GitHub App credentials, global webhook, customer provisioning).
 * 3. Repository Overrides & Diagnostics (per-repo settings & HMAC test pings).
 * 4. WebAuthn Passkeys for passwordless authentication.
 */

export interface PemValidationResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly type?: string;
}

export interface ApiKeyValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

/** Validates that the supplied string is a structured PEM-encoded private key. */
export function validatePem(pem: string): PemValidationResult {
  if (!pem || typeof pem !== 'string') {
    return { valid: false, error: 'Private key is empty' };
  }
  const trimmed = pem.trim();
  const match = trimmed.match(/^-----BEGIN (?:([A-Z ]+) )?PRIVATE KEY-----[\s\S]*?-----END (?:([A-Z ]+) )?PRIVATE KEY-----$/);
  if (!match) {
    return {
      valid: false,
      error: 'Invalid PEM format. Must start with -----BEGIN ... PRIVATE KEY----- and end with -----END ... PRIVATE KEY-----',
    };
  }
  const type = match[1] || match[2] || 'PKCS#8 / Standard';
  return { valid: true, type };
}

/** Validates known API key prefixes and basic formatting for BYOK providers. */
export function validateApiKey(provider: string, key: string): ApiKeyValidationResult {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'Key is empty' };
  }
  const trimmed = key.trim();
  // If it's already masked (e.g. from server display), consider it valid
  if (trimmed.includes('••••')) {
    return { valid: true };
  }

  switch (provider.toLowerCase()) {
    case 'anthropic':
      if (!trimmed.startsWith('sk-ant-')) {
        return { valid: false, error: 'Anthropic keys typically begin with sk-ant-' };
      }
      if (trimmed.length < 20) {
        return { valid: false, error: 'Anthropic key is too short' };
      }
      return { valid: true };

    case 'openai':
      if (!trimmed.startsWith('sk-')) {
        return { valid: false, error: 'OpenAI keys typically begin with sk-' };
      }
      if (trimmed.length < 20) {
        return { valid: false, error: 'OpenAI key is too short' };
      }
      return { valid: true };

    case 'deepseek':
      if (!trimmed.startsWith('sk-')) {
        return { valid: false, error: 'DeepSeek keys typically begin with sk-' };
      }
      if (trimmed.length < 20) {
        return { valid: false, error: 'DeepSeek key is too short' };
      }
      return { valid: true };

    case 'gemini':
      if (!trimmed.startsWith('AIza')) {
        return { valid: false, error: 'Google Gemini API keys typically begin with AIza' };
      }
      if (trimmed.length < 20) {
        return { valid: false, error: 'Gemini key is too short' };
      }
      return { valid: true };

    default:
      return { valid: true };
  }
}

/** Formats masked display of secret strings. */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return '••••••••';
  const start = secret.slice(0, 4);
  const end = secret.slice(-4);
  return `${start}••••••••${end}`;
}

export function buildWebhookUrl(origin: string, owner: string, repo: string): string {
  const base = origin.replace(/\/+$/, '');
  const r = `${owner.trim()}/${repo.trim()}`;
  return `${base}/webhooks/github/${r}`;
}

export function bufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64UrlToBuffer(base64url: string): Uint8Array {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ------------------------------------------------------------- DOM Dashboard Wiring

export interface AdminSession {
  authenticated: boolean;
  login: string | null;
  isRootAdmin: boolean;
  githubConfigured: boolean;
  appSlug: string | null;
  hasControlKey: boolean;
  signingConfigured: boolean;
}

export function initAdminDashboard(): void {
  const statusAlert = document.getElementById('admin-status') as HTMLElement | null;

  // Session Bar Elements
  const authStateText = document.getElementById('auth-state-text') as HTMLElement | null;
  const userBadge = document.getElementById('user-badge') as HTMLElement | null;
  const rootBadge = document.getElementById('root-badge') as HTMLElement | null;
  const btnGithubLogin = document.getElementById('btn-github-login') as HTMLAnchorElement | null;
  const btnPasskeyLogin = document.getElementById('btn-passkey-login') as HTMLButtonElement | null;
  const btnPasskeyRegister = document.getElementById('btn-passkey-register') as HTMLButtonElement | null;
  const btnLogout = document.getElementById('btn-logout') as HTMLButtonElement | null;
  const userAccountLabel = document.getElementById('user-account-label') as HTMLElement | null;

  // Tabs
  const tabBtnUser = document.getElementById('tab-btn-user') as HTMLButtonElement | null;
  const tabBtnRoot = document.getElementById('tab-btn-root') as HTMLButtonElement | null;
  const tabBtnRepo = document.getElementById('tab-btn-repo') as HTMLButtonElement | null;
  const tabContentUser = document.getElementById('tab-content-user') as HTMLElement | null;
  const tabContentRoot = document.getElementById('tab-content-root') as HTMLElement | null;
  const tabContentRepo = document.getElementById('tab-content-repo') as HTMLElement | null;

  // Root Elements
  const rootUnlockCard = document.getElementById('root-unlock-card') as HTMLElement | null;
  const rootBootstrapKeyInput = document.getElementById('root-bootstrap-key') as HTMLInputElement | null;
  const btnRootLogin = document.getElementById('btn-root-login') as HTMLButtonElement | null;
  const appIdInput = document.getElementById('github-app-id') as HTMLInputElement | null;
  const appSlugInput = document.getElementById('github-app-slug') as HTMLInputElement | null;
  const clientIdInput = document.getElementById('github-client-id') as HTMLInputElement | null;
  const clientSecretInput = document.getElementById('github-client-secret') as HTMLInputElement | null;
  const pemFileInput = document.getElementById('github-pem-file') as HTMLInputElement | null;
  const pemTextInput = document.getElementById('github-pem-text') as HTMLTextAreaElement | null;
  const pemStatus = document.getElementById('pem-status') as HTMLElement | null;
  const systemWebhookUrlInput = document.getElementById('system-webhook-url') as HTMLInputElement | null;
  const systemCallbackUrlInput = document.getElementById('system-callback-url') as HTMLInputElement | null;
  const systemWebhookSecretInput = document.getElementById('system-webhook-secret') as HTMLInputElement | null;
  const btnSystemPing = document.getElementById('btn-system-ping') as HTMLButtonElement | null;
  const systemPingStatus = document.getElementById('system-ping-status') as HTMLElement | null;
  const systemPlatformOwnersInput = document.getElementById('system-platform-owners') as HTMLInputElement | null;
  const systemAllowedUsersInput = document.getElementById('system-allowed-users') as HTMLInputElement | null;
  const systemAllowAllCheckbox = document.getElementById('system-allow-all') as HTMLInputElement | null;
  const btnSaveSystem = document.getElementById('btn-save-system') as HTMLButtonElement | null;
  const rootPasskeyTbody = document.getElementById('root-passkey-tbody') as HTMLElement | null;
  const btnRegisterPasskeyRoot = document.getElementById('btn-register-passkey-root') as HTMLButtonElement | null;

  // User BYOK Elements
  const anthropicKeyInput = document.getElementById('anthropic-key') as HTMLInputElement | null;
  const anthropicModelInput = document.getElementById('anthropic-model') as HTMLInputElement | null;
  const openaiKeyInput = document.getElementById('openai-key') as HTMLInputElement | null;
  const openaiModelInput = document.getElementById('openai-model') as HTMLInputElement | null;
  const deepseekKeyInput = document.getElementById('deepseek-key') as HTMLInputElement | null;
  const deepseekModelInput = document.getElementById('deepseek-model') as HTMLInputElement | null;
  const geminiKeyInput = document.getElementById('gemini-key') as HTMLInputElement | null;
  const geminiModelInput = document.getElementById('gemini-model') as HTMLInputElement | null;
  const btnSaveUser = document.getElementById('btn-save-user') as HTMLButtonElement | null;

  // User Repositories Elements
  const userRepoFilter = document.getElementById('user-repo-filter') as HTMLInputElement | null;
  const userOrgFilter = document.getElementById('user-org-filter') as HTMLSelectElement | null;
  const btnSyncRepos = document.getElementById('btn-sync-repos') as HTMLButtonElement | null;
  const userRepoList = document.getElementById('user-repo-list') as HTMLElement | null;
  const addRepoInput = document.getElementById('add-repo-input') as HTMLInputElement | null;
  const btnAddRepo = document.getElementById('btn-add-repo') as HTMLButtonElement | null;
  const userPasskeyTbody = document.getElementById('user-passkey-tbody') as HTMLElement | null;
  const btnRegisterPasskeyUser = document.getElementById('btn-register-passkey-user') as HTMLButtonElement | null;

  // Repo Overrides Tab Elements (Backward Compatibility)
  const ownerInput = document.getElementById('admin-owner') as HTMLInputElement | null;
  const repoInput = document.getElementById('admin-repo') as HTMLInputElement | null;
  const keyInput = document.getElementById('admin-key') as HTMLInputElement | null;
  const webhookUrlInput = document.getElementById('webhook-url') as HTMLInputElement | null;
  const webhookSecretInput = document.getElementById('webhook-secret') as HTMLInputElement | null;
  const pingStatus = document.getElementById('ping-status') as HTMLElement | null;
  const btnLoad = document.getElementById('btn-load') as HTMLButtonElement | null;
  const btnSave = document.getElementById('btn-save') as HTMLButtonElement | null;
  const btnPing = document.getElementById('btn-ping') as HTMLButtonElement | null;

  let currentSession: AdminSession = {
    authenticated: false,
    login: null,
    isRootAdmin: false,
    githubConfigured: false,
    appSlug: null,
    hasControlKey: false,
    signingConfigured: false,
  };

  let loadedRepositories: Array<{ fullName: string; owner: string; name: string; isPrivate: boolean; defaultBranch: string }> = [];

  const showStatus = (msg: string, isError = false) => {
    if (!statusAlert) return;
    statusAlert.textContent = msg;
    statusAlert.className = isError ? 'alert alert--danger' : 'alert alert--success';
    statusAlert.hidden = false;
  };

  // Populate System URLs
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://cloud-factory-cf.dev';
  if (systemWebhookUrlInput) systemWebhookUrlInput.value = `${origin}/webhooks/github`;
  if (systemCallbackUrlInput) systemCallbackUrlInput.value = `${origin}/auth/github/callback`;

  // Tab Switching
  const switchTab = (tab: 'user' | 'root' | 'repo') => {
    tabBtnUser?.classList.toggle('admin-tab--active', tab === 'user');
    tabBtnRoot?.classList.toggle('admin-tab--active', tab === 'root');
    tabBtnRepo?.classList.toggle('admin-tab--active', tab === 'repo');

    tabBtnUser?.setAttribute('aria-selected', String(tab === 'user'));
    tabBtnRoot?.setAttribute('aria-selected', String(tab === 'root'));
    tabBtnRepo?.setAttribute('aria-selected', String(tab === 'repo'));

    if (tabContentUser) tabContentUser.hidden = tab !== 'user';
    if (tabContentRoot) tabContentRoot.hidden = tab !== 'root';
    if (tabContentRepo) tabContentRepo.hidden = tab !== 'repo';
  };

  tabBtnUser?.addEventListener('click', () => switchTab('user'));
  tabBtnRoot?.addEventListener('click', () => switchTab('root'));
  tabBtnRepo?.addEventListener('click', () => switchTab('repo'));

  // Update per-repo webhook URL
  const updateRepoWebhookUrl = () => {
    const owner = ownerInput?.value.trim() ?? '';
    const repo = repoInput?.value.trim() ?? '';
    if (webhookUrlInput) {
      webhookUrlInput.value = owner && repo ? buildWebhookUrl(origin, owner, repo) : '';
    }
  };
  ownerInput?.addEventListener('input', updateRepoWebhookUrl);
  repoInput?.addEventListener('input', updateRepoWebhookUrl);

  // Check Session
  const refreshSession = async (): Promise<void> => {
    try {
      const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
      if (res.ok) {
        currentSession = (await res.json()) as AdminSession;
      }
    } catch {
      // offline or error
    }

    if (authStateText) {
      if (currentSession.authenticated) {
        authStateText.textContent = `Active session: @${currentSession.login ?? 'user'}`;
      } else {
        authStateText.textContent = 'Not signed in';
      }
    }

    if (userBadge) {
      userBadge.hidden = !currentSession.authenticated;
      if (currentSession.login) userBadge.textContent = `@${currentSession.login}`;
    }

    if (rootBadge) {
      rootBadge.hidden = !currentSession.isRootAdmin;
    }

    if (userAccountLabel) {
      userAccountLabel.textContent = currentSession.login ? `@${currentSession.login} scope` : 'account scope';
    }

    if (btnGithubLogin) {
      btnGithubLogin.hidden = currentSession.authenticated;
    }

    if (btnPasskeyLogin) {
      btnPasskeyLogin.hidden = currentSession.authenticated;
    }

    if (btnPasskeyRegister) {
      btnPasskeyRegister.hidden = !currentSession.authenticated;
    }

    if (btnLogout) {
      btnLogout.hidden = !currentSession.authenticated;
    }

    if (rootUnlockCard) {
      rootUnlockCard.hidden = currentSession.isRootAdmin;
    }

    // Auto-load data for authenticated session
    if (currentSession.authenticated) {
      void loadUserSettings();
      void loadUserRepositories();
      void loadUserPasskeys();
    }

    if (currentSession.isRootAdmin) {
      void loadSystemSettings();
      void loadRootPasskeys();
    }
  };

  // PEM upload & validation
  pemFileInput?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      if (pemTextInput) {
        pemTextInput.value = text;
        pemTextInput.dispatchEvent(new Event('input'));
      }
    } catch {
      showStatus('Failed to read private key file', true);
    }
  });

  pemTextInput?.addEventListener('input', () => {
    const val = pemTextInput.value.trim();
    if (!pemStatus) return;
    if (!val) {
      pemStatus.textContent = '';
      pemStatus.className = 'badge';
      return;
    }
    const res = validatePem(val);
    if (res.valid) {
      pemStatus.textContent = `Valid (${res.type})`;
      pemStatus.className = 'badge badge--ok';
    } else {
      pemStatus.textContent = res.error ?? 'Invalid PEM';
      pemStatus.className = 'badge badge--error';
    }
  });

  // Root Bootstrap Unlock
  btnRootLogin?.addEventListener('click', async () => {
    const key = rootBootstrapKeyInput?.value.trim();
    if (!key) {
      showStatus('Please enter the root bootstrap password / control key', true);
      return;
    }
    try {
      showStatus('Unlocking root administrator access...');
      const res = await fetch('/api/auth/root-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ controlKey: key }),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.ok) {
        showStatus('Root Administrator access unlocked successfully!');
        if (rootBootstrapKeyInput) rootBootstrapKeyInput.value = '';
        await refreshSession();
        switchTab('root');
      } else {
        showStatus(data.error ?? 'Root unlock failed', true);
      }
    } catch (err: unknown) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  });

  // Logout
  btnLogout?.addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      showStatus('Signed out');
      await refreshSession();
    } catch {
      // ignore
    }
  });

  // Passkey Login
  btnPasskeyLogin?.addEventListener('click', async () => {
    if (!window.PublicKeyCredential) {
      showStatus('WebAuthn / Passkeys are not supported on this browser/device', true);
      return;
    }
    try {
      showStatus('Initiating Passkey sign-in...');
      const optRes = await fetch('/api/auth/passkey/login/options', { method: 'POST', credentials: 'same-origin' });
      const optData = (await optRes.json()) as any;
      if (!optRes.ok || !optData.options) {
        showStatus(optData.error ?? 'Failed to get Passkey options', true);
        return;
      }

      const options = optData.options;
      options.challenge = base64UrlToBuffer(options.challenge);

      const assertion = (await navigator.credentials.get({
        publicKey: options,
      })) as PublicKeyCredential;

      if (!assertion) {
        showStatus('Passkey sign-in cancelled', true);
        return;
      }

      const response = assertion.response as AuthenticatorAssertionResponse;
      const verifyRes = await fetch('/api/auth/passkey/login/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          credentialId: bufferToBase64Url(assertion.rawId),
          authenticatorData: bufferToBase64Url(response.authenticatorData),
          clientDataJSON: bufferToBase64Url(response.clientDataJSON),
          signature: bufferToBase64Url(response.signature),
        }),
      });

      const verifyData = (await verifyRes.json()) as any;
      if (verifyRes.ok && verifyData.ok) {
        showStatus(`Welcome back! Signed in with Passkey as ${verifyData.login}`);
        await refreshSession();
      } else {
        showStatus(verifyData.error ?? 'Passkey verification failed', true);
      }
    } catch (err: unknown) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  });

  // Register Passkey helper
  const registerPasskey = async (role: 'user' | 'root'): Promise<void> => {
    if (!window.PublicKeyCredential) {
      showStatus('WebAuthn / Passkeys are not supported on this browser/device', true);
      return;
    }
    const label = prompt('Enter a label for this passkey (e.g. Mac Touch ID):', 'My Passkey') || 'My Passkey';
    try {
      showStatus('Creating passkey credentials...');
      const optRes = await fetch('/api/auth/passkey/register/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ role }),
      });
      const optData = (await optRes.json()) as any;
      if (!optRes.ok || !optData.options) {
        showStatus(optData.error ?? 'Failed to get passkey options', true);
        return;
      }

      const options = optData.options;
      options.challenge = base64UrlToBuffer(options.challenge);
      options.user.id = base64UrlToBuffer(options.user.id);

      const credential = (await navigator.credentials.create({
        publicKey: options,
      })) as PublicKeyCredential;

      if (!credential) {
        showStatus('Passkey registration cancelled', true);
        return;
      }

      const response = credential.response as AuthenticatorAttestationResponse;
      let publicKeySpki = '';
      let algorithm = -7;
      if (typeof (response as any).getPublicKey === 'function') {
        const pkBuf = (response as any).getPublicKey();
        if (pkBuf) publicKeySpki = bufferToBase64Url(pkBuf);
      }
      if (typeof (response as any).getPublicKeyAlgorithm === 'function') {
        algorithm = (response as any).getPublicKeyAlgorithm();
      }

      const verifyRes = await fetch('/api/auth/passkey/register/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          credentialId: bufferToBase64Url(credential.rawId),
          clientDataJSON: bufferToBase64Url(response.clientDataJSON),
          publicKeySpki,
          algorithm,
          label,
        }),
      });

      const verifyData = (await verifyRes.json()) as any;
      if (verifyRes.ok && verifyData.ok) {
        showStatus(`Passkey registered successfully! (${label})`);
        if (role === 'root') {
          await loadRootPasskeys();
        } else {
          await loadUserPasskeys();
        }
      } else {
        showStatus(verifyData.error ?? 'Passkey registration failed', true);
      }
    } catch (err: unknown) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  };

  btnPasskeyRegister?.addEventListener('click', () => registerPasskey('user'));
  btnRegisterPasskeyUser?.addEventListener('click', () => registerPasskey('user'));
  btnRegisterPasskeyRoot?.addEventListener('click', () => registerPasskey('root'));

  // Load / Render User Passkeys
  const loadUserPasskeys = async (): Promise<void> => {
    if (!userPasskeyTbody) return;
    try {
      const res = await fetch('/api/auth/passkeys', { credentials: 'same-origin' });
      const data = (await res.json()) as any;
      if (res.ok && Array.isArray(data.passkeys) && data.passkeys.length > 0) {
        userPasskeyTbody.innerHTML = '';
        for (const pk of data.passkeys) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><strong>${pk.label}</strong></td>
            <td><span class="badge">${pk.role}</span></td>
            <td>${new Date(pk.createdAt).toLocaleDateString()}</td>
            <td><button type="button" class="button button--ghost btn-delete-passkey" data-id="${pk.credentialId}">Revoke</button></td>
          `;
          userPasskeyTbody.appendChild(tr);
        }
        wireDeletePasskeys(userPasskeyTbody, () => loadUserPasskeys());
      } else {
        userPasskeyTbody.innerHTML = '<tr><td colspan="4" class="muted">No passkeys registered for this account</td></tr>';
      }
    } catch {
      // ignore
    }
  };

  // Load / Render Root Passkeys
  const loadRootPasskeys = async (): Promise<void> => {
    if (!rootPasskeyTbody) return;
    try {
      const res = await fetch('/api/auth/passkeys?subject=__root__', { credentials: 'same-origin' });
      const data = (await res.json()) as any;
      if (res.ok && Array.isArray(data.passkeys) && data.passkeys.length > 0) {
        rootPasskeyTbody.innerHTML = '';
        for (const pk of data.passkeys) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><strong>${pk.label}</strong></td>
            <td>${new Date(pk.createdAt).toLocaleDateString()}</td>
            <td><button type="button" class="button button--ghost btn-delete-passkey" data-id="${pk.credentialId}">Revoke</button></td>
          `;
          rootPasskeyTbody.appendChild(tr);
        }
        wireDeletePasskeys(rootPasskeyTbody, () => loadRootPasskeys());
      } else {
        rootPasskeyTbody.innerHTML = '<tr><td colspan="3" class="muted">No root passkeys registered</td></tr>';
      }
    } catch {
      // ignore
    }
  };

  const wireDeletePasskeys = (container: HTMLElement, onDone: () => void) => {
    container.querySelectorAll('.btn-delete-passkey').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = (e.currentTarget as HTMLElement).getAttribute('data-id');
        if (!id) return;
        if (!confirm('Revoke this passkey?')) return;
        try {
          const res = await fetch(`/api/auth/passkeys?id=${encodeURIComponent(id)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
          });
          if (res.ok) {
            showStatus('Passkey revoked');
            onDone();
          }
        } catch {
          // ignore
        }
      });
    });
  };

  // Load User BYOK Settings
  const loadUserSettings = async (): Promise<void> => {
    try {
      const res = await fetch('/api/admin/user-settings', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = (await res.json()) as any;
      const ai = data.aiProviders ?? {};
      if (anthropicKeyInput && ai.anthropic?.maskedKey) anthropicKeyInput.value = ai.anthropic.maskedKey;
      if (anthropicModelInput && ai.anthropic?.model) anthropicModelInput.value = ai.anthropic.model;

      if (openaiKeyInput && ai.openai?.maskedKey) openaiKeyInput.value = ai.openai.maskedKey;
      if (openaiModelInput && ai.openai?.model) openaiModelInput.value = ai.openai.model;

      if (deepseekKeyInput && ai.deepseek?.maskedKey) deepseekKeyInput.value = ai.deepseek.maskedKey;
      if (deepseekModelInput && ai.deepseek?.model) deepseekModelInput.value = ai.deepseek.model;

      if (geminiKeyInput && ai.gemini?.maskedKey) geminiKeyInput.value = ai.gemini.maskedKey;
      if (geminiModelInput && ai.gemini?.model) geminiModelInput.value = ai.gemini.model;
    } catch {
      // ignore
    }
  };

  // Save User BYOK Settings
  btnSaveUser?.addEventListener('click', async () => {
    const payload: any = {
      aiProviders: {
        anthropic: {
          key: anthropicKeyInput?.value.trim().includes('••••') ? undefined : anthropicKeyInput?.value.trim(),
          model: anthropicModelInput?.value,
        },
        openai: {
          key: openaiKeyInput?.value.trim().includes('••••') ? undefined : openaiKeyInput?.value.trim(),
          model: openaiModelInput?.value,
        },
        deepseek: {
          key: deepseekKeyInput?.value.trim().includes('••••') ? undefined : deepseekKeyInput?.value.trim(),
          model: deepseekModelInput?.value,
        },
        gemini: {
          key: geminiKeyInput?.value.trim().includes('••••') ? undefined : geminiKeyInput?.value.trim(),
          model: geminiModelInput?.value,
        },
      },
    };

    try {
      showStatus('Saving User BYOK Settings...');
      const res = await fetch('/api/admin/user-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.ok) {
        showStatus('User BYOK settings saved successfully! Keys now power your account.');
        await loadUserSettings();
      } else {
        showStatus(data.error ?? `Save failed (HTTP ${res.status})`, true);
      }
    } catch (err: unknown) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  });

  // Load User Repositories
  const loadUserRepositories = async (): Promise<void> => {
    try {
      const res = await fetch('/api/repos', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = (await res.json().catch(() => ({}))) as any;
      if (data.ok && Array.isArray(data.repositories)) {
        loadedRepositories = data.repositories;
        populateOrgFilter();
        renderRepositories();
      }
    } catch {
      // ignore
    }
  };

  const populateOrgFilter = () => {
    if (!userOrgFilter) return;
    const orgs = new Set<string>();
    for (const r of loadedRepositories) {
      if (r.owner) orgs.add(r.owner);
    }
    userOrgFilter.innerHTML = '<option value="">All Organizations</option>';
    for (const org of Array.from(orgs).sort()) {
      const opt = document.createElement('option');
      opt.value = org;
      opt.textContent = org;
      userOrgFilter.appendChild(opt);
    }
  };

  const renderRepositories = () => {
    if (!userRepoList) return;
    const search = userRepoFilter?.value.trim().toLowerCase() ?? '';
    const selectedOrg = userOrgFilter?.value.trim().toLowerCase() ?? '';

    const filtered = loadedRepositories.filter((r) => {
      const matchesSearch = !search || r.fullName.toLowerCase().includes(search);
      const matchesOrg = !selectedOrg || r.owner.toLowerCase() === selectedOrg;
      return matchesSearch && matchesOrg;
    });

    if (filtered.length === 0) {
      userRepoList.innerHTML = '<div class="muted" style="padding:16px; text-align:center;">No matching repositories found.</div>';
      return;
    }

    userRepoList.innerHTML = '';
    for (const r of filtered) {
      const div = document.createElement('div');
      div.className = 'repo-item';
      div.innerHTML = `
        <div class="repo-item__meta">
          <span class="repo-item__title">${r.fullName}</span>
          <span class="badge ${r.isPrivate ? '' : 'badge--ok'}">${r.isPrivate ? 'Private' : 'Public'}</span>
          <span class="muted" style="font-size:0.8rem;">branch: ${r.defaultBranch || 'main'}</span>
        </div>
        <div class="repo-item__actions">
          <a href="/?owner=${encodeURIComponent(r.owner)}&repo=${encodeURIComponent(r.name)}" class="button button--ghost" style="text-decoration:none;">Open in Canvas →</a>
          <button type="button" class="button button--ghost btn-repo-ping" data-owner="${r.owner}" data-repo="${r.name}">Ping</button>
          <button type="button" class="button button--ghost btn-repo-override" data-owner="${r.owner}" data-repo="${r.name}">Overrides</button>
        </div>
      `;
      userRepoList.appendChild(div);
    }

    // Wire actions
    userRepoList.querySelectorAll('.btn-repo-ping').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const target = e.currentTarget as HTMLElement;
        const owner = target.getAttribute('data-owner');
        const repo = target.getAttribute('data-repo');
        if (!owner || !repo) return;
        showStatus(`Sending test ping for ${owner}/${repo}...`);
        try {
          const res = await fetch(`/api/admin/test-ping/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
            method: 'POST',
            credentials: 'same-origin',
          });
          const data = (await res.json().catch(() => ({}))) as any;
          if (res.ok && data.ok) {
            showStatus(`Ping accepted for ${owner}/${repo}: ${data.message}`);
          } else {
            showStatus(data.error ?? `Ping failed (HTTP ${res.status})`, true);
          }
        } catch (err: unknown) {
          showStatus(err instanceof Error ? err.message : String(err), true);
        }
      });
    });

    userRepoList.querySelectorAll('.btn-repo-override').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const owner = target.getAttribute('data-owner');
        const repo = target.getAttribute('data-repo');
        if (!owner || !repo) return;
        if (ownerInput) ownerInput.value = owner;
        if (repoInput) repoInput.value = repo;
        updateRepoWebhookUrl();
        switchTab('repo');
        btnLoad?.click();
      });
    });
  };

  userRepoFilter?.addEventListener('input', renderRepositories);
  userOrgFilter?.addEventListener('change', renderRepositories);
  btnSyncRepos?.addEventListener('click', () => loadUserRepositories());

  // Add Repository manually
  btnAddRepo?.addEventListener('click', async () => {
    const val = addRepoInput?.value.trim();
    if (!val || !val.includes('/')) {
      showStatus('Please specify repository in format owner/repo', true);
      return;
    }
    const [owner, name] = val.split('/') as [string, string];
    try {
      showStatus(`Adding repository ${val}...`);
      const res = await fetch('/api/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ fullName: val, owner, name, isPrivate: false }),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.ok) {
        showStatus(`Repository ${val} added to your account!`);
        if (addRepoInput) addRepoInput.value = '';
        await loadUserRepositories();
      } else {
        showStatus(data.error ?? 'Failed to add repository', true);
      }
    } catch (err: unknown) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  });

  // Load Root System Settings
  const loadSystemSettings = async (): Promise<void> => {
    try {
      const res = await fetch('/api/admin/system', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = (await res.json()) as any;
      if (appIdInput && data.githubApp?.appId) appIdInput.value = data.githubApp.appId;
      if (appSlugInput && data.githubApp?.appSlug) appSlugInput.value = data.githubApp.appSlug;
      if (clientIdInput && data.githubApp?.clientId) clientIdInput.value = data.githubApp.clientId;
      if (clientSecretInput && data.githubApp?.clientSecretMasked) clientSecretInput.value = data.githubApp.clientSecretMasked;
      if (pemStatus && data.githubApp?.hasPrivateKey) {
        pemStatus.textContent = `Saved (${data.githubApp?.privateKeyFingerprint ?? 'present'})`;
        pemStatus.className = 'badge badge--ok';
      }
      if (systemWebhookSecretInput && data.webhook?.secretMasked) {
        systemWebhookSecretInput.value = data.webhook.secretMasked;
      }
      if (systemPlatformOwnersInput && Array.isArray(data.customers?.platformOwners)) {
        systemPlatformOwnersInput.value = data.customers.platformOwners.join(', ');
      }
      if (systemAllowedUsersInput && Array.isArray(data.customers?.allowedUsers)) {
        systemAllowedUsersInput.value = data.customers.allowedUsers.join(', ');
      }
      if (systemAllowAllCheckbox) {
        systemAllowAllCheckbox.checked = data.customers?.allowAllGithubUsers !== false;
      }
    } catch {
      // ignore
    }
  };

  // Save Root System Settings
  btnSaveSystem?.addEventListener('click', async () => {
    const pemVal = pemTextInput?.value.trim();
    if (pemVal && !pemVal.includes('••••')) {
      const pemCheck = validatePem(pemVal);
      if (!pemCheck.valid) {
        showStatus(pemCheck.error ?? 'Invalid PEM private key', true);
        return;
      }
    }

    const payload: any = {
      githubApp: {
        appId: appIdInput?.value.trim() || undefined,
        appSlug: appSlugInput?.value.trim() || undefined,
        clientId: clientIdInput?.value.trim() || undefined,
        clientSecret: clientSecretInput?.value.trim().includes('••••') ? undefined : clientSecretInput?.value.trim(),
        privateKey: pemVal && !pemVal.includes('••••') ? pemVal : undefined,
      },
      webhookSecret: systemWebhookSecretInput?.value.trim().includes('••••') ? undefined : systemWebhookSecretInput?.value.trim(),
      customers: {
        allowAllGithubUsers: systemAllowAllCheckbox?.checked ?? true,
        allowedUsers: systemAllowedUsersInput?.value.split(',').map((s) => s.trim()).filter(Boolean),
        platformOwners: systemPlatformOwnersInput?.value.split(',').map((s) => s.trim()).filter(Boolean),
      },
    };

    try {
      showStatus('Saving Root System Settings...');
      const res = await fetch('/api/admin/system', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.ok) {
        showStatus('Root System Settings saved successfully!');
        await loadSystemSettings();
      } else {
        showStatus(data.error ?? `Save failed (HTTP ${res.status})`, true);
      }
    } catch (err: unknown) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  });

  // System Test Ping
  btnSystemPing?.addEventListener('click', async () => {
    if (systemPingStatus) {
      systemPingStatus.textContent = 'Pinging...';
      systemPingStatus.className = 'badge';
    }
    try {
      const res = await fetch('/api/admin/system/test-ping', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.ok) {
        if (systemPingStatus) {
          systemPingStatus.textContent = `202 Accepted (${data.deliveryId})`;
          systemPingStatus.className = 'badge badge--ok';
        }
        showStatus(`System webhook verified: ${data.message}`);
      } else {
        if (systemPingStatus) {
          systemPingStatus.textContent = `Failed (${res.status})`;
          systemPingStatus.className = 'badge badge--error';
        }
        showStatus(data.error ?? `Ping failed (HTTP ${res.status})`, true);
      }
    } catch (err: unknown) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  });

  // =========================================================================
  // Backward-Compatible Per-Repository Overrides (Tab 3) Handlers
  // =========================================================================
  btnLoad?.addEventListener('click', async () => {
    const owner = ownerInput?.value.trim() ?? '';
    const repo = repoInput?.value.trim() ?? '';
    const key = keyInput?.value.trim() ?? '';
    if (!owner || !repo) {
      showStatus('Please specify owner and repo', true);
      return;
    }
    try {
      showStatus('Loading repository settings...');
      const headers: Record<string, string> = {};
      if (key) headers['x-factory-control-key'] = key;
      const res = await fetch(`/api/admin/settings/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        headers,
        credentials: 'same-origin',
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        showStatus(data.error ?? `Load failed: HTTP ${res.status}`, true);
        return;
      }

      if (webhookSecretInput && data.webhook?.secretMasked) {
        webhookSecretInput.value = data.webhook.secretMasked;
      }
      showStatus('Repository settings loaded');
    } catch (err: unknown) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  });

  btnSave?.addEventListener('click', async () => {
    const owner = ownerInput?.value.trim() ?? '';
    const repo = repoInput?.value.trim() ?? '';
    const key = keyInput?.value.trim() ?? '';
    if (!owner || !repo) {
      showStatus('Please specify owner and repo', true);
      return;
    }

    const payload: any = {};
    const webhookSec = webhookSecretInput?.value.trim();
    if (webhookSec && !webhookSec.includes('••••')) {
      payload.webhookSecret = webhookSec;
    }

    try {
      showStatus('Saving repository overrides...');
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (key) headers['x-factory-control-key'] = key;
      const res = await fetch(`/api/admin/settings/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.ok) {
        showStatus('Repository overrides saved successfully');
        btnLoad?.click();
      } else {
        showStatus(data.error ?? `Save failed (HTTP ${res.status})`, true);
      }
    } catch (err: unknown) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  });

  btnPing?.addEventListener('click', async () => {
    const owner = ownerInput?.value.trim() ?? '';
    const repo = repoInput?.value.trim() ?? '';
    const key = keyInput?.value.trim() ?? '';
    if (!owner || !repo) {
      showStatus('Supply owner and repo to trigger test ping', true);
      return;
    }
    if (pingStatus) {
      pingStatus.textContent = 'Sending ping...';
      pingStatus.className = 'badge';
    }
    try {
      const headers: Record<string, string> = {};
      if (key) headers['x-factory-control-key'] = key;
      const res = await fetch(`/api/admin/test-ping/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.ok) {
        if (pingStatus) {
          pingStatus.textContent = `202 Accepted (ID: ${data.deliveryId})`;
          pingStatus.className = 'badge badge--ok';
        }
        showStatus(`Test ping sent: ${data.message}`);
      } else {
        if (pingStatus) {
          pingStatus.textContent = `Failed (${res.status})`;
          pingStatus.className = 'badge badge--error';
        }
        showStatus(data.error ?? `Test ping failed (HTTP ${res.status})`, true);
      }
    } catch (err: unknown) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  });

  // Query parameter defaults
  const urlParams = new URLSearchParams(window.location.search);
  const qOwner = urlParams.get('owner');
  const qRepo = urlParams.get('repo');
  const qTab = urlParams.get('tab');
  if (qOwner && ownerInput) ownerInput.value = qOwner;
  if (qRepo && repoInput) repoInput.value = qRepo;
  updateRepoWebhookUrl();

  if (qTab === 'root') {
    switchTab('root');
  } else if (qTab === 'repo') {
    switchTab('repo');
  } else {
    switchTab('user');
  }

  // Refresh auth and session on load
  void refreshSession();
}

// Auto-run if running in browser
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initAdminDashboard());
  } else {
    initAdminDashboard();
  }
}
