/**
 * Admin Dashboard & Settings: GitHub App credentials, .pem upload,
 * webhook test ping, and BYOK AI provider configuration.
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

// ------------------------------------------------------------- DOM Dashboard Wiring

export function initAdminDashboard(): void {
  const ownerInput = document.getElementById('admin-owner') as HTMLInputElement | null;
  const repoInput = document.getElementById('admin-repo') as HTMLInputElement | null;
  const keyInput = document.getElementById('admin-key') as HTMLInputElement | null;

  const btnLoad = document.getElementById('btn-load') as HTMLButtonElement | null;
  const btnSave = document.getElementById('btn-save') as HTMLButtonElement | null;
  const btnPing = document.getElementById('btn-ping') as HTMLButtonElement | null;

  const statusAlert = document.getElementById('admin-status') as HTMLElement | null;

  // GitHub App elements
  const appIdInput = document.getElementById('github-app-id') as HTMLInputElement | null;
  const clientIdInput = document.getElementById('github-client-id') as HTMLInputElement | null;
  const clientSecretInput = document.getElementById('github-client-secret') as HTMLInputElement | null;
  const pemFileInput = document.getElementById('github-pem-file') as HTMLInputElement | null;
  const pemTextInput = document.getElementById('github-pem-text') as HTMLTextAreaElement | null;
  const pemStatus = document.getElementById('pem-status') as HTMLElement | null;

  // Webhook elements
  const webhookUrlInput = document.getElementById('webhook-url') as HTMLInputElement | null;
  const webhookSecretInput = document.getElementById('webhook-secret') as HTMLInputElement | null;
  const pingStatus = document.getElementById('ping-status') as HTMLElement | null;

  // AI Provider elements
  const anthropicKeyInput = document.getElementById('anthropic-key') as HTMLInputElement | null;
  const anthropicModelInput = document.getElementById('anthropic-model') as HTMLSelectElement | null;
  const openaiKeyInput = document.getElementById('openai-key') as HTMLInputElement | null;
  const openaiModelInput = document.getElementById('openai-model') as HTMLSelectElement | null;
  const deepseekKeyInput = document.getElementById('deepseek-key') as HTMLInputElement | null;
  const deepseekModelInput = document.getElementById('deepseek-model') as HTMLSelectElement | null;
  const geminiKeyInput = document.getElementById('gemini-key') as HTMLInputElement | null;
  const geminiModelInput = document.getElementById('gemini-model') as HTMLSelectElement | null;

  const showStatus = (msg: string, isError = false) => {
    if (!statusAlert) return;
    statusAlert.textContent = msg;
    statusAlert.className = isError ? 'alert alert--danger' : 'alert alert--success';
    statusAlert.hidden = false;
  };

  const getScope = () => {
    const owner = ownerInput?.value.trim() ?? '';
    const repo = repoInput?.value.trim() ?? '';
    const key = keyInput?.value.trim() ?? '';
    return { owner, repo, key };
  };

  const updateWebhookUrlDisplay = () => {
    const { owner, repo } = getScope();
    if (webhookUrlInput) {
      webhookUrlInput.value = owner && repo ? buildWebhookUrl(window.location.origin, owner, repo) : '';
    }
  };

  ownerInput?.addEventListener('input', updateWebhookUrlDisplay);
  repoInput?.addEventListener('input', updateWebhookUrlDisplay);

  // Parse query params for default scope
  const urlParams = new URLSearchParams(window.location.search);
  const qOwner = urlParams.get('owner');
  const qRepo = urlParams.get('repo');
  if (qOwner && ownerInput) ownerInput.value = qOwner;
  if (qRepo && repoInput) repoInput.value = qRepo;
  updateWebhookUrlDisplay();

  // PEM file upload handling
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

  // PEM text validation
  pemTextInput?.addEventListener('input', () => {
    const val = pemTextInput.value.trim();
    if (!pemStatus) return;
    if (!val) {
      pemStatus.textContent = '';
      pemStatus.className = 'pem-badge';
      return;
    }
    const res = validatePem(val);
    if (res.valid) {
      pemStatus.textContent = `Valid (${res.type})`;
      pemStatus.className = 'pem-badge pem-badge--ok';
    } else {
      pemStatus.textContent = res.error ?? 'Invalid PEM';
      pemStatus.className = 'pem-badge pem-badge--error';
    }
  });

  // Load settings
  btnLoad?.addEventListener('click', async () => {
    const { owner, repo, key } = getScope();
    if (!owner || !repo) {
      showStatus('Please specify owner and repo', true);
      return;
    }
    if (!key) {
      showStatus('Please supply the control key', true);
      return;
    }

    try {
      showStatus('Loading settings...');
      const res = await fetch(`/api/admin/settings/${owner}/${repo}`, {
        headers: { 'x-factory-control-key': key },
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as any;
        showStatus(data.error ?? `Load failed: HTTP ${res.status}`, true);
        return;
      }

      const data = (await res.json()) as any;
      if (appIdInput) appIdInput.value = data.githubApp?.appId ?? '';
      if (clientIdInput) clientIdInput.value = data.githubApp?.clientId ?? '';
      if (clientSecretInput) {
        clientSecretInput.value = data.githubApp?.clientSecretMasked ?? '';
      }
      if (pemStatus && data.githubApp?.hasPrivateKey) {
        pemStatus.textContent = `Saved (${data.githubApp?.privateKeyFingerprint ?? 'present'})`;
        pemStatus.className = 'pem-badge pem-badge--ok';
      }

      if (webhookSecretInput) {
        webhookSecretInput.value = data.webhook?.secretMasked ?? '';
      }

      const ai = data.aiProviders ?? {};
      if (anthropicKeyInput) anthropicKeyInput.value = ai.anthropic?.maskedKey ?? '';
      if (anthropicModelInput && ai.anthropic?.model) anthropicModelInput.value = ai.anthropic.model;

      if (openaiKeyInput) openaiKeyInput.value = ai.openai?.maskedKey ?? '';
      if (openaiModelInput && ai.openai?.model) openaiModelInput.value = ai.openai.model;

      if (deepseekKeyInput) deepseekKeyInput.value = ai.deepseek?.maskedKey ?? '';
      if (deepseekModelInput && ai.deepseek?.model) deepseekModelInput.value = ai.deepseek.model;

      if (geminiKeyInput) geminiKeyInput.value = ai.gemini?.maskedKey ?? '';
      if (geminiModelInput && ai.gemini?.model) geminiModelInput.value = ai.gemini.model;

      showStatus('Settings loaded successfully');
    } catch (err: unknown) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  });

  // Save settings
  btnSave?.addEventListener('click', async () => {
    const { owner, repo, key } = getScope();
    if (!owner || !repo) {
      showStatus('Please specify owner and repo', true);
      return;
    }
    if (!key) {
      showStatus('Please supply the control key', true);
      return;
    }

    // Validate inputs
    const pemVal = pemTextInput?.value.trim();
    if (pemVal && !pemVal.includes('••••')) {
      const pemCheck = validatePem(pemVal);
      if (!pemCheck.valid) {
        showStatus(pemCheck.error ?? 'Invalid PEM private key', true);
        return;
      }
    }

    const anthropicKey = anthropicKeyInput?.value.trim();
    if (anthropicKey && !anthropicKey.includes('••••')) {
      const v = validateApiKey('anthropic', anthropicKey);
      if (!v.valid) {
        showStatus(v.error ?? 'Invalid Anthropic API key', true);
        return;
      }
    }

    const openaiKey = openaiKeyInput?.value.trim();
    if (openaiKey && !openaiKey.includes('••••')) {
      const v = validateApiKey('openai', openaiKey);
      if (!v.valid) {
        showStatus(v.error ?? 'Invalid OpenAI API key', true);
        return;
      }
    }

    const deepseekKey = deepseekKeyInput?.value.trim();
    if (deepseekKey && !deepseekKey.includes('••••')) {
      const v = validateApiKey('deepseek', deepseekKey);
      if (!v.valid) {
        showStatus(v.error ?? 'Invalid DeepSeek API key', true);
        return;
      }
    }

    const geminiKey = geminiKeyInput?.value.trim();
    if (geminiKey && !geminiKey.includes('••••')) {
      const v = validateApiKey('gemini', geminiKey);
      if (!v.valid) {
        showStatus(v.error ?? 'Invalid Gemini API key', true);
        return;
      }
    }

    const payload: any = {
      githubApp: {
        appId: appIdInput?.value.trim() || undefined,
        clientId: clientIdInput?.value.trim() || undefined,
        clientSecret: clientSecretInput?.value.trim().includes('••••') ? undefined : clientSecretInput?.value.trim(),
        privateKey: pemVal && !pemVal.includes('••••') ? pemVal : undefined,
      },
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

    const webhookSec = webhookSecretInput?.value.trim();
    if (webhookSec && !webhookSec.includes('••••')) {
      payload.webhookSecret = webhookSec;
    }

    try {
      showStatus('Saving settings...');
      const res = await fetch(`/api/admin/settings/${owner}/${repo}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-factory-control-key': key,
        },
        body: JSON.stringify(payload),
      });

      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok || data.ok !== true) {
        showStatus(data.error ?? `Save failed (HTTP ${res.status})`, true);
        return;
      }

      showStatus(`Settings saved successfully (${data.updated?.length ?? 0} field(s) updated)`);
      // Reload to reflect masked keys
      btnLoad?.click();
    } catch (err: unknown) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  });

  // Test Ping trigger
  btnPing?.addEventListener('click', async () => {
    const { owner, repo, key } = getScope();
    if (!owner || !repo || !key) {
      showStatus('Supply owner, repo, and control key to trigger test ping', true);
      return;
    }

    if (pingStatus) {
      pingStatus.textContent = 'Sending ping...';
      pingStatus.className = 'ping-badge ping-badge--pending';
    }

    try {
      const res = await fetch(`/api/admin/test-ping/${owner}/${repo}`, {
        method: 'POST',
        headers: { 'x-factory-control-key': key },
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.ok) {
        if (pingStatus) {
          pingStatus.textContent = `202 Accepted (ID: ${data.deliveryId})`;
          pingStatus.className = 'ping-badge ping-badge--ok';
        }
        showStatus(`Test ping sent and accepted: ${data.message}`);
      } else {
        if (pingStatus) {
          pingStatus.textContent = `Failed (${res.status})`;
          pingStatus.className = 'ping-badge ping-badge--error';
        }
        showStatus(data.error ?? `Test ping failed: ${data.message}`, true);
      }
    } catch (err: unknown) {
      if (pingStatus) {
        pingStatus.textContent = 'Error';
        pingStatus.className = 'ping-badge ping-badge--error';
      }
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  });
}

// Auto-run if running in a browser environment with the DOM ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initAdminDashboard());
  } else {
    initAdminDashboard();
  }
}
