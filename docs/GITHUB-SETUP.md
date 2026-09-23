# GitHub setup: going public and locking it down

What this gets you, in one line: **anyone can read and fork; only the
maintainers team can push; nothing reaches `main` without a pull request and at
least one approving review; only maintainers can cut a release.**

Work through it in order. Steps 1-2 happen before the repo is public; the rest
harden it afterwards. Every UI path has a `gh` equivalent — pick whichever you
prefer, they do the same thing.

Companion pages: [RELEASING.md](./RELEASING.md) for the release flow itself,
[../CONTRIBUTING.md](../CONTRIBUTING.md) for what contributors see.

---

## The permission model in 30 seconds

GitHub has no "publish" permission of its own. Everything below reduces to two
facts:

1. **Write access is the whole game.** Push, merge, create a tag, publish a
   release, and trigger `workflow_dispatch` are all the same permission. So the
   rule is: *almost nobody has write*, and write is further constrained by
   rulesets.
2. **Outside contributors never get write.** On a public repo they fork, push to
   their fork, and open a pull request. They cannot push to this repository at
   all, and no setting is required to make that true — it is the default. What
   you are configuring below is the behaviour of the *few* people who do have
   write.

| Who | Access | Can do |
| --- | --- | --- |
| The world | Read (implicit, public repo) | Read, fork, open issues and PRs |
| `@Sarv/contributors` | Triage (optional) | Label and close issues, no push |
| `@Sarv/maintainers` | **Write** | Review, approve, merge PRs |
| Release cutters | **Admin** | The above, plus manage settings and bypass rules |

Keep the admin list to one or two people. Everyone else, including regular
maintainers, works through pull requests.

---

## 1. Pre-flight: before the repo is public

Making a repo public publishes **every commit in its history**, not just the
current tree. A secret deleted in a later commit is still in the history and
still readable.

```bash
# Anything env-shaped ever committed?
git log --all --name-only --pretty=format: -- '*.env' '.env.*' '*.p12' '*.pem' '*.key' | sort -u

# Obvious key shapes anywhere in history (bounded output on purpose)
git grep -nIE 'AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-|ghp_[A-Za-z0-9]{36}' \
  $(git rev-list --all) -- 2>/dev/null | head -20
```

If either turns up a live secret, **rotate it** — rewriting history is not a fix
once something has been pushed, and it is not a fix at all once the repo is
public. Rotate first, rewrite second if you still want to.

Also confirm before flipping the switch:

- `LICENSE` is present and says what you intend. Sarv Inbox ships the **Sarv
  Community License** — source-available / fair-code, deliberately **not**
  OSI-approved open source. Say so plainly in the README so nobody arrives
  expecting MIT.
- `.env` is ignored and not tracked: `git ls-files | grep -c '^\.env$'` prints `0`.
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and
  `.github/ISSUE_TEMPLATE` exist — they are the first thing a stranger reads.
- `.github/CODEOWNERS` names a team that actually exists (step 3).

## 2. Make the repository public

**Settings -> General -> Danger Zone -> Change repository visibility -> Public.**

```bash
gh repo edit Sarv/Inbox --visibility public --accept-visibility-change-consequences
```

Two things change the moment you do this, both of which this project wants:

- **Free arm64 runners become available**, so the `linux-arm64` entry in the
  release matrix starts working. While the repo is private that job cannot find
  a runner. See [RELEASING.md](./RELEASING.md).
- **Rulesets, secret scanning and push protection become free.** On a private
  repo they need GitHub Team or Enterprise.

## 3. Teams and access

**Settings -> Collaborators and teams.**

```bash
gh api -X PUT /orgs/Sarv/teams/maintainers/repos/Sarv/Inbox -f permission=push
```

> **`@Sarv/maintainers` MUST have write access or CODEOWNERS is silently
> ignored.** GitHub does not warn you: it requests no reviewer, the rule appears
> to be configured, and PRs merge with no owner review. `.github/CODEOWNERS`
> carries this warning too. Verify it after the change — step 8.

Remove any leftover individual collaborators; grant access through teams only,
so revoking someone is one action in one place.

```bash
gh api /repos/Sarv/Inbox/collaborators --jq '.[] | "\(.login)\t\(.role_name)"'
```

## 4. The `main` ruleset: no unreviewed change ever lands

**Settings -> Rules -> Rulesets -> New ruleset -> New branch ruleset.**

Name it `main`, set **Enforcement status: Active**, and under **Target branches**
add **Include default branch**.

Enable these rules:

| Rule | Setting |
| --- | --- |
| Restrict deletions | on |
| Block force pushes | on |
| Require linear history | on |
| Require a pull request before merging | on, configured below |
| Require status checks to pass | on, configured in step 5 |

Under **Require a pull request before merging**:

| Option | Value | Why |
| --- | --- | --- |
| **Required approvals** | **1** | The rule you asked for: nothing merges unmerged-unseen |
| Dismiss stale pull request approvals when new commits are pushed | on | An approval describes the diff that was read, not the branch name |
| Require review from Code Owners | on | Routes security-sensitive paths to maintainers automatically |
| Require approval of the most recent reviewable push | on | Stops someone approving their own last commit |
| Require conversation resolution before merging | on | An unanswered review comment is not a merged review |

**Bypass list:** add `@Sarv/maintainers` only if you want the release script to
push the version bump straight to `main`. Otherwise leave the bypass list
**empty** and cut releases with `./scripts/release.sh minor --pr`, which routes
the bump through a reviewed PR like any other change. Empty is the stricter and
better default; see "Allow the release to push" in
[RELEASING.md](./RELEASING.md).

<details>
<summary><code>gh</code> equivalent</summary>

```bash
# Team id for the bypass list. Omit the bypass_actors block entirely to use --pr.
TEAM_ID=$(gh api /orgs/Sarv/teams/maintainers --jq .id)

cat > /tmp/main-ruleset.json <<JSON
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [
    { "actor_id": $TEAM_ID, "actor_type": "Team", "bypass_mode": "always" }
  ],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true
      }
    },
    { "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Type-check & build" },
          { "context": "Renderer bundle guard (no Node-only deps)" },
          { "context": "Unit & integration tests" },
          { "context": "Dependency vulnerability scan" },
          { "context": "Analyze (javascript-typescript)" }
        ]
      }
    }
  ]
}
JSON

gh api -X POST /repos/Sarv/Inbox/rulesets --input /tmp/main-ruleset.json
```

</details>

## 5. Required status checks

Under **Require status checks to pass**, also tick **Require branches to be up
to date before merging**, then add these five by name. They are the *job display
names*, which is what GitHub matches on — not the job ids, and not the workflow
names:

| Check | Workflow |
| --- | --- |
| `Type-check & build` | `ci.yml` |
| `Renderer bundle guard (no Node-only deps)` | `ci.yml` |
| `Unit & integration tests` | `ci.yml` |
| `Dependency vulnerability scan` | `ci.yml` |
| `Analyze (javascript-typescript)` | `codeql.yml` |

A check name that does not match anything **blocks every PR forever** — the
check never reports, so the PR waits for a result that cannot arrive. If a PR
hangs on a pending check, that typo is the first thing to look at. GitHub only
autocompletes checks it has seen recently, so if a name is not offered, push a
throwaway PR first and it will appear.

Do **not** add the `Release` workflow's jobs. They run on tags, never on PRs, so
requiring them would deadlock every pull request.

## 6. Protect the release tags

Pushing a `vX.Y.Z` tag is what starts a build and creates a release, so the tag
is the real publish trigger and deserves its own rule.

**Settings -> Rules -> Rulesets -> New ruleset -> New tag ruleset.** Name it
`release-tags`, Active, target pattern `v*`, and enable **Restrict creations**,
**Restrict updates** and **Restrict deletions**. Put `@Sarv/maintainers` in the
bypass list — they are then the only people who can create a `v*` tag.

<details>
<summary><code>gh</code> equivalent</summary>

```bash
TEAM_ID=$(gh api /orgs/Sarv/teams/maintainers --jq .id)

cat > /tmp/tag-ruleset.json <<JSON
{
  "name": "release-tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [
    { "actor_id": $TEAM_ID, "actor_type": "Team", "bypass_mode": "always" }
  ],
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }]
}
JSON

gh api -X POST /repos/Sarv/Inbox/rulesets --input /tmp/tag-ruleset.json
```

</details>

## 7. Actions settings

**Settings -> Actions -> General.**

| Setting | Value | Why |
| --- | --- | --- |
| Actions permissions | Allow `Sarv`, and select non-`Sarv` actions -> **Allow actions created by GitHub** + **Allow specified actions**: `pnpm/action-setup@*`, `github/codeql-action/*` | A workflow can only run actions you listed, so a compromised third-party action cannot be introduced by a PR |
| Fork pull request workflows from outside collaborators | **Require approval for all external contributors** | The stricter of the two; the default only gates first-time contributors |
| Workflow permissions | **Read repository contents and packages permissions** | `release.yml` grants `contents: write` to the publish job alone; everything else stays read-only |
| Allow GitHub Actions to create and approve pull requests | **off** | Otherwise a workflow could satisfy your own review requirement |

### Secrets and fork pull requests

**Secrets are not exposed to a workflow triggered by a `pull_request` event from
a fork.** That is GitHub's behaviour and it is what you want: a stranger's PR
cannot read `APPLE_CERTIFICATE_P12` by adding a step that prints it.

The consequence to know about: `ci.yml` builds the renderer on fork PRs with
`SARVINBOX_GOOGLE_CLIENT_ID` and friends unset. That build succeeds — the app
just has no Gmail sign-in — so CI stays green and no contributor is blocked.

Never add `pull_request_target` to a workflow to work around this. It runs
*with* secrets against the fork's code, which is the standard way repositories
get their secrets stolen.

Secrets themselves live in **Settings -> Secrets and variables -> Actions**; the
full list is in [RELEASING.md](./RELEASING.md).

### Optional: gate publishing behind a human

For a second lock on the publish step, create an environment
(**Settings -> Environments -> New environment**, name it `release`), add
**Required reviewers**, and add `environment: release` to the `publish` job in
`.github/workflows/release.yml`. The build then runs unattended and the publish
job waits for a named person to approve it.

The workflow already publishes as a **draft**, so a human click is required
before anything reaches users either way. The environment adds a second gate for
the artifacts themselves.

## 8. Security features

**Settings -> Advanced Security / Code security.** All free on a public repo:

| Feature | Setting |
| --- | --- |
| Private vulnerability reporting | on — gives `SECURITY.md` a real reporting channel |
| Dependabot alerts + security updates | on — `.github/dependabot.yml` already configures the update schedule |
| Secret scanning | on |
| Secret scanning push protection | on — blocks a commit containing a key *before* it lands |
| CodeQL | already running via `.github/workflows/codeql.yml` |

```bash
gh api -X PATCH /repos/Sarv/Inbox -f security_and_analysis='{
  "secret_scanning": { "status": "enabled" },
  "secret_scanning_push_protection": { "status": "enabled" }
}'
gh api -X PUT /repos/Sarv/Inbox/private-vulnerability-reporting
```

## 9. Merge settings

**Settings -> General -> Pull Requests.**

- **Allow squash merging** on, with the commit message set to **Pull request
  title and description** — that keeps `main` matching the
  `<type>(<scope>): <subject>` convention the changelog generator parses. A
  merge commit whose subject is "Merge pull request #12" produces no changelog
  entry.
- **Allow merge commits** off, **Allow rebase merging** off. Required linear
  history (step 4) already rejects merge commits; turning them off here means
  nobody is offered a button that will fail.
- **Automatically delete head branches** on.

## 10. Verify it

Do this once, from an account that is not an admin if you can.

```bash
# 1. Rulesets are active and target what you think
gh api /repos/Sarv/Inbox/rulesets --jq '.[] | "\(.name)\t\(.target)\t\(.enforcement)"'

# 2. A direct push to main is refused
git checkout main && git commit --allow-empty -m "test: protection check" && git push origin main
#    expect: "protected branch hook declined" (an admin in the bypass list will
#    succeed instead, which is also correct if you configured a bypass)
git reset --hard HEAD~1

# 3. CODEOWNERS parses and resolves. An empty errors array is the pass.
gh api /repos/Sarv/Inbox/codeowners/errors --jq '.errors'
```

Then open one throwaway PR and confirm, on the PR page:

- `@Sarv/maintainers` was **requested for review automatically** (if not, the
  team does not have write access — step 3).
- Merge is blocked with "Review required" and all five checks are listed.
- Approving from a second account unblocks merge; pushing another commit
  dismisses that approval again.

Close the PR. You are done.

---

## What a contributor experiences

Worth knowing, because it is the thing you cannot see from the inside:

1. They fork, branch, push to their fork, open a PR. No access to this repo is
   needed or granted at any point.
2. CI runs on their PR without secrets, and a maintainer approves the run the
   first time.
3. `CODEOWNERS` requests `@Sarv/maintainers`. One approval plus five green
   checks unblocks the merge button — which only a maintainer can click.
4. They can never push a tag, publish a release, read a secret, or change a
   setting.

That is the whole of "except contributors, no one can push or publish".
