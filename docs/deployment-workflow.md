# Deployment workflow

Production deploys are releases, not development checkpoints.

## Branch roles

| Branch | Purpose | Netlify behavior |
| --- | --- | --- |
| `develop` | Persistent integration and testing branch | Stable branch deploy after each push, once enabled in Netlify |
| Feature branches | Isolated work proposed to `develop` | Deploy Preview for each pull request |
| `main` | Production release history only | Production build only when the commit message contains `[release]` |

Netlify considers the branch selected as the site's **Production branch** to be production. Keep that setting on `main`. A push to `main` would normally cause a production deploy; this repository adds a second gate in `netlify.toml` that skips production builds unless the target commit message contains `[release]`.

## One-time service settings

These settings live in Netlify and GitHub and cannot be fully enforced by files in this repository.

### Netlify

In **Project configuration → Build & deploy → Continuous Deployment → Branches and deploy contexts**:

1. Keep **Production branch** set to `main`.
2. Keep **Deploy Previews** enabled.
3. Set **Branch deploys** to **Let me add individual branches**, and add `develop` only.

Do not set `develop` as the production branch. Its stable branch URL will follow Netlify's branch-deploy URL pattern and will not replace the primary site.

### GitHub

Protect `main` with a branch rule or ruleset:

1. Require a pull request before merging.
2. Require the `Release policy` and `test-and-build` status checks.
3. Block force pushes and branch deletion.
4. Apply the rule to administrators if the repository plan supports it.

Protect `develop` by requiring the `test-and-build` check before merging. GitHub plan and repository visibility determine which protection controls are available.

## Routine development

1. Start work from `develop`; use a feature branch when the change benefits from isolated review.
2. Open feature pull requests against `develop`.
3. Test the Netlify Deploy Preview for the pull request.
4. Merge into `develop` only after tests and the preview pass.
5. Use the stable `develop` branch-deploy URL for integrated testing.

Routine commits and pull requests must not target `main`.

## Deliberate production release

1. Confirm `develop` is release-ready in its stable branch deploy.
2. Run `npm test` and `npm run build` locally.
3. Open a pull request from `develop` to `main` whose title begins with `[release] `.
4. Wait for the `Release policy`, `test-and-build`, and Netlify preview checks to pass.
5. Merge using **Squash and merge**, preserving the `[release]` prefix in the commit message. If another merge method is used, confirm the final commit message on `main` contains `[release]` before merging.
6. Verify the resulting production deploy and record any release notes.

The `[release]` marker is deliberately checked from the final commit on `main`, not merely from the pull request title. Without that marker, Netlify's production-context ignore command exits successfully and cancels the build before a production deploy is created.

## Emergency release

For an urgent fix, still work through `develop` and the release pull request when possible. If the normal route is unavailable, a maintainer may put `[release]` in a deliberately pushed commit to `main`; branch protections should make this exceptional path explicit.

Netlify build hooks bypass ignore commands. Treat every production build hook as a release credential, keep its URL private, and invoke it only for a deliberate release.

## Verification commands

The production gate can be tested without contacting Netlify:

```powershell
$env:COMMIT_REF = (git rev-parse HEAD)
node ./scripts/netlify-ignore-production.mjs
$LASTEXITCODE # 0 means skip; 1 means build
```

Use a temporary commit containing `[release]` only in an isolated test branch if the continue-build path needs to be exercised. Do not push that branch to `main`.
