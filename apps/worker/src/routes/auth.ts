import type { Env } from "../env";

export const AUTH_LOGIN_PATH = "/auth/github/login";
export const AUTH_CALLBACK_PATH = "/auth/github/callback";
export const API_REPOS_PATH = "/api/repos";

export async function handleAuth(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === AUTH_LOGIN_PATH) {
    return handleGithubLogin(request, env, url);
  }

  if (url.pathname === AUTH_CALLBACK_PATH) {
    return handleGithubCallback(request, env, url);
  }

  if (url.pathname === API_REPOS_PATH) {
    return handleApiRepos(request, env, url);
  }

  return null;
}

export async function handleGithubLogin(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const clientId = url.searchParams.get("client_id") ?? env.GITHUB_CLIENT_ID;
  const appSlug = url.searchParams.get("app_slug") ?? env.GITHUB_APP_SLUG;
  const state = url.searchParams.get("state") ?? crypto.randomUUID().slice(0, 12);
  const redirectUri = url.searchParams.get("redirect_uri");

  const callbackUrl = new URL(AUTH_CALLBACK_PATH, url.origin);
  if (redirectUri) {
    callbackUrl.searchParams.set("return_to", redirectUri);
  }

  // 1. If App installation flow is requested and slug is known, route to GitHub App install
  const flow = url.searchParams.get("flow");
  if (flow === "install" && appSlug) {
    const installUrl = `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
    return Response.redirect(installUrl, 302);
  }

  // 2. Standard OAuth authorization flow
  if (!clientId) {
    return Response.json(
      {
        ok: false,
        error: "GitHub Client ID is not configured (set GITHUB_CLIENT_ID or supply ?client_id=...)",
      },
      { status: 503 },
    );
  }

  const oauthUrl = new URL("https://github.com/login/oauth/authorize");
  oauthUrl.searchParams.set("client_id", clientId);
  oauthUrl.searchParams.set("redirect_uri", callbackUrl.toString());
  oauthUrl.searchParams.set("scope", "repo,read:org");
  oauthUrl.searchParams.set("state", state);

  return Response.redirect(oauthUrl.toString(), 302);
}

export async function handleGithubCallback(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const code = url.searchParams.get("code");
  const installationId = url.searchParams.get("installation_id");
  const state = url.searchParams.get("state") ?? "";
  const returnTo = url.searchParams.get("return_to") ?? "/";

  // If no code and no installationId, user cancelled or error
  if (!code && !installationId) {
    const errorDesc = url.searchParams.get("error_description") ?? "No authorization code provided";
    return Response.json({ ok: false, error: errorDesc }, { status: 400 });
  }

  const clientId = url.searchParams.get("client_id") ?? env.GITHUB_CLIENT_ID ?? "github_app_client_id";
  const clientSecret = url.searchParams.get("client_secret") ?? env.GITHUB_CLIENT_SECRET ?? "github_app_client_secret";
  let accessToken: string | null = null;

  // 1. Exchange code for user access token if code is present
  if (code && clientId && clientSecret) {
    try {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "CloudFactory-Auth",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      });

      if (tokenRes.ok) {
        const tokenData = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
        if (typeof tokenData["access_token"] === "string") {
          accessToken = tokenData["access_token"];
        }
      }
    } catch {
      // Token exchange failed; proceed if installationId is present
    }
  }

  let accountLogin = "unknown";
  let accountType = "User";
  const discoveredRepos: Array<{ fullName: string; owner: string; name: string; private: boolean; defaultBranch: string }> = [];

  // 2. If access token available, query GitHub API for user & repos
  if (accessToken) {
    try {
      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "CloudFactory-Auth",
        },
      });

      if (userRes.ok) {
        const userData = (await userRes.json()) as any;
        accountLogin = userData.login ?? "unknown";
        accountType = userData.type ?? "User";
      }

      const reposRes = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "CloudFactory-Auth",
        },
      });

      if (reposRes.ok) {
        const reposData = (await reposRes.json()) as any[];
        if (Array.isArray(reposData)) {
          for (const r of reposData) {
            if (r.full_name) {
              discoveredRepos.push({
                fullName: r.full_name,
                owner: r.owner?.login ?? accountLogin,
                name: r.name,
                private: Boolean(r.private),
                defaultBranch: r.default_branch ?? "main",
              });
            }
          }
        }
      }
    } catch {
      // Upstream GitHub fetch error
    }
  }

  // 3. Persist authorized repositories into OrgCoordinator DO
  if (accountLogin !== "unknown" && env.ORG_COORDINATOR) {
    const orgCoordinator = env.ORG_COORDINATOR.get(env.ORG_COORDINATOR.idFromName(accountLogin));
    await orgCoordinator.fetch("https://org-coordinator.internal/installations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installationId: installationId || undefined,
        accountLogin,
        accountType,
        repos: discoveredRepos,
      }),
    });
  }

  // 4. Redirect user back to the application canvas
  const redirectUrl = new URL(returnTo, url.origin);
  redirectUrl.searchParams.set("connected", "1");
  if (accountLogin !== "unknown") {
    redirectUrl.searchParams.set("owner", accountLogin);
  }
  if (installationId) {
    redirectUrl.searchParams.set("installation_id", installationId);
  }

  return Response.redirect(redirectUrl.toString(), 302);
}

export async function handleApiRepos(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const owner = url.searchParams.get("owner");
  if (!owner) {
    return Response.json(
      { ok: false, error: "Missing required query parameter ?owner=<login>" },
      { status: 400 },
    );
  }

  if (!env.ORG_COORDINATOR) {
    return Response.json({ ok: false, error: "OrgCoordinator is not configured" }, { status: 503 });
  }

  const orgCoordinator = env.ORG_COORDINATOR.get(env.ORG_COORDINATOR.idFromName(owner));
  const reposRes = await orgCoordinator.fetch("https://org-coordinator.internal/repos");
  const data = await reposRes.json();

  return Response.json(data, { status: reposRes.status });
}
