import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adapterFor,
  canonicalAction,
  giteaAdapter,
  githubAdapter,
  gitlabAdapter,
  isDevPlatform,
  parseRepositoryKey,
  repositoryKey,
  type HeaderReader,
  type SdlcEvent,
} from '../src/index.ts';

/**
 * ADR 003 / cloud-factory-cf-6to.1: one canonical SdlcEvent per forge, so the
 * pipeline and sinks stop branching on the provider.
 */

function headers(entries: Record<string, string>): HeaderReader {
  const lower = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

const GITHUB_PR = JSON.stringify({
  action: 'opened',
  number: 7,
  sender: { login: 'octocat' },
  repository: { full_name: 'acme/widget' },
});

test('normalises a GitHub pull request delivery', () => {
  const event = githubAdapter.normalise(
    JSON.parse(GITHUB_PR),
    headers({ 'x-github-delivery': 'gh-1', 'x-github-event': 'pull_request' }),
  ) as SdlcEvent;
  assert.deepEqual(event, {
    platform: 'github',
    deliveryId: 'gh-1',
    rawEvent: 'pull_request',
    kind: 'merge_request',
    action: 'opened',
    canonicalAction: 'opened',
    repository: 'acme/widget',
    actor: 'octocat',
  });
  assert.equal(githubAdapter.webhookPath('acme/widget'), '/webhooks/github/acme/widget');
});

test('normalises a GitLab merge request and a pipeline', () => {
  const merge = gitlabAdapter.normalise(
    {
      object_kind: 'merge_request',
      user: { username: 'tanuki' },
      project: { path_with_namespace: 'group/project' },
      object_attributes: { action: 'open', iid: 3 },
    },
    headers({ 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'gl-1' }),
  ) as SdlcEvent;
  assert.equal(merge.platform, 'gitlab');
  assert.equal(merge.kind, 'merge_request');
  assert.equal(merge.action, 'open');
  // GitLab's "open" is the portable "opened": the vocabulary is ours, not theirs.
  assert.equal(merge.canonicalAction, 'opened');
  assert.equal(merge.repository, 'group/project');
  assert.equal(merge.actor, 'tanuki');
  assert.equal(merge.deliveryId, 'gl-1');

  const pipeline = gitlabAdapter.normalise(
    { object_kind: 'pipeline', project: { path_with_namespace: 'group/project' }, object_attributes: { status: 'failed' } },
    headers({ 'x-gitlab-event': 'Pipeline Hook', 'x-gitlab-event-uuid': 'gl-2' }),
  ) as SdlcEvent;
  assert.equal(pipeline.kind, 'pipeline');
  assert.equal(pipeline.action, null);
  assert.equal(pipeline.canonicalAction, null);
});

test('falls back to the GitLab payload kind when the event header is missing', () => {
  // A proxy that strips headers must not turn every delivery into `unknown`.
  const event = gitlabAdapter.normalise(
    { object_kind: 'merge_request', project: { path_with_namespace: 'group/project' } },
    headers({ 'x-gitlab-event-uuid': 'gl-3' }),
  ) as SdlcEvent;
  assert.equal(event.rawEvent, 'merge_request');
  assert.equal(event.kind, 'merge_request');
  assert.equal(event.action, null);
});

test('normalises a Gitea/Forgejo delivery, accepting either header family', () => {
  const body = {
    action: 'opened',
    sender: { login: 'forge-user' },
    repository: { full_name: 'forge/repo' },
  };
  const gitea = giteaAdapter.normalise(
    body,
    headers({ 'x-gitea-event': 'pull_request', 'x-gitea-delivery': 'gt-1' }),
  ) as SdlcEvent;
  assert.equal(gitea.platform, 'gitea');
  assert.equal(gitea.kind, 'merge_request');
  assert.equal(gitea.repository, 'forge/repo');
  assert.equal(gitea.actor, 'forge-user');

  const forgejo = giteaAdapter.normalise(
    body,
    headers({ 'x-forgejo-event': 'pull_request', 'x-forgejo-delivery': 'fj-1' }),
  ) as SdlcEvent;
  assert.equal(forgejo.deliveryId, 'fj-1');
  assert.equal(forgejo.rawEvent, 'pull_request');
});

test('refuses a payload it cannot trust instead of inventing an event', () => {
  for (const [adapter, headerSet] of [
    [githubAdapter, { 'x-github-delivery': 'd', 'x-github-event': 'push' }],
    [gitlabAdapter, { 'x-gitlab-event-uuid': 'd', 'x-gitlab-event': 'Push Hook' }],
    [giteaAdapter, { 'x-gitea-delivery': 'd', 'x-gitea-event': 'push' }],
  ] as const) {
    const h = headers(headerSet);
    assert.equal(adapter.normalise(null, h), null);
    assert.equal(adapter.normalise('not a payload', h), null);
    assert.equal(adapter.normalise([], h), null);
    // A payload that names no repository cannot be attributed to a tenant.
    assert.equal(adapter.normalise({ action: 'opened' }, h), null);
    // No delivery id means no idempotency key, so the event is not accepted.
    assert.equal(adapter.normalise({ repository: { full_name: 'acme/widget' } }, headers({})), null);
  }
});

test('unknown provider events are recorded as unknown, never dropped', () => {
  const event = githubAdapter.normalise(
    { repository: { full_name: 'acme/widget' } },
    headers({ 'x-github-delivery': 'gh-9', 'x-github-event': 'deployment_status' }),
  ) as SdlcEvent;
  assert.equal(event.kind, 'unknown');
  assert.equal(event.rawEvent, 'deployment_status');
});

test('canonical action covers the portable states and nothing invented', () => {
  assert.equal(canonicalAction('opened'), 'opened');
  assert.equal(canonicalAction('OPEN'), 'opened');
  assert.equal(canonicalAction('reopened'), 'opened');
  assert.equal(canonicalAction('synchronize'), 'updated');
  assert.equal(canonicalAction('edited'), 'updated');
  assert.equal(canonicalAction('merge'), 'merged');
  assert.equal(canonicalAction('closed'), 'closed');
  assert.equal(canonicalAction('labeled'), null);
  assert.equal(canonicalAction(null), null);
});

test('repository identity includes the platform, so two forges never share state', () => {
  assert.equal(repositoryKey('github', 'acme/widget'), 'github:acme/widget');
  assert.notEqual(repositoryKey('github', 'acme/widget'), repositoryKey('gitlab', 'acme/widget'));
  assert.deepEqual(parseRepositoryKey('gitlab:group/project'), { platform: 'gitlab', repository: 'group/project' });
  assert.equal(parseRepositoryKey('acme/widget'), null);
  assert.equal(parseRepositoryKey('bitbucket:acme/widget'), null);
  assert.equal(parseRepositoryKey(':acme/widget'), null);
  assert.equal(parseRepositoryKey('github:'), null);
});

test('adapters are addressable by platform name', () => {
  assert.equal(adapterFor('github'), githubAdapter);
  assert.equal(adapterFor('gitlab'), gitlabAdapter);
  assert.equal(adapterFor('gitea'), giteaAdapter);
  assert.equal(adapterFor('bitbucket'), null);
  assert.equal(isDevPlatform('gitea'), true);
  assert.equal(isDevPlatform('unknown'), false);
});
