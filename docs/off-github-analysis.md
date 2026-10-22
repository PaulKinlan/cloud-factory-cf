# Off-GitHub repository tree ingestion

The analysis tree endpoint accepts repository snapshots without a GitHub API token or webhook. It is protected by the same `x-factory-control-key` as other control-plane endpoints. Select an independent repository namespace with `?platform=gitlab` or `?platform=gitea` (omitting `platform` uses `github`).

- `POST /analysis/:owner/:repo/tree?platform=gitlab` with `Content-Type: application/json`: `{ "source": "isomorphic-git", "revision": "<commit id>", "files": [{ "path": "src/index.ts", "size": 123, "content": "optional UTF-8 file text" }] }`. A local isomorphic-git client can walk its tree and upload this snapshot. Binary files should omit `content` while retaining their byte `size`.
- `POST /analysis/:owner/:repo/tree?platform=gitlab&revision=v1` with `Content-Type: application/x-tar` or `application/gzip`: raw ustar archive bytes (gzip wraps a ustar archive). Regular files are indexed; binary files retain path and size. Links, devices and tar extensions are rejected. A revision is required for archive ingestion.
- `GET /analysis/:owner/:repo/tree?platform=gitlab[&prefix=src/]`: revision, source and ordered file paths/sizes.
- `GET /analysis/:owner/:repo/tree/files/src%2Findex.ts?platform=gitlab`: path, size and optional text content.

Snapshots replace the previous tree atomically in the repository's SQLite-backed `RepoCoordinator`. Paths are relative and cannot contain traversal. Uploads and unpacked tar archives are capped at 4 MiB, at most 5,000 files; this is an analysis snapshot, not a git clone or an executable checkout. No remote URL is fetched by the Worker. Existing webhook, PR review, canvas and event paths are unchanged.
