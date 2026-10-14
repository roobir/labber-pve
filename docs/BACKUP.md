# Backups to a Git repository

**Settings → Backup** commits labber's labs, runbooks, activity log and
settings to a folder of a GitHub, GitHub Enterprise Server or Forgejo /
Gitea repository. The kind of server is detected automatically (or set it
under **Server**). No user name is needed anywhere: the token identifies
you.
Backups run on a schedule (monthly by default) and from **back up now**.

Each backup is **one commit** that makes the backup folder match the
current state (on Forgejo only the files that changed are sent), so the
repository's history is the backup history. A lab
deleted in labber is gone from the next backup, but stays in the history.
Files outside the folder are never touched, so several labber instances
can share one repository, one folder each.

## What is in a backup

```
<folder>/
  manifest.json              labber version, host, counts, what was left out
  labs/<name>.lab.yml        every lab file, exactly as written
  state/<name>.lab.yml.json  deployed labs: VM ids, management IPs
  runbooks/<name>/<v>.yml    every runbook version, with its <v>.meta.json
  activity/<day>.jsonl       the activity log (Settings -> Activity)
  runs/<id>.json             run history, only if "include run history" is on
  settings/proxmox.json      Proxmox host, node, templates -- no token or password
  settings/api-settings.json public API / relay switches
  settings/users.json        user names only
  settings/backup.json       these backup settings -- no access token
```

**Never included:** the Store (passwords, licences, master keys, saved
device configs), the Proxmox API token and password, password hashes,
API-relay token hashes, and the backup access token itself. The list of
what is read is fixed in `lib/backup/collect.js`, so a new secret file
cannot end up in a backup by accident.

## Setting it up

1. **Create a private repository** for backups, for example `team/labber`.
2. **Create an access token** that can write to it, and only to it:
   - **GitHub / GitHub Enterprise:** a fine-grained token for this
     repository only, with *Contents: read and write*. Use a classic token
     with the `repo` scope only if your GitHub Enterprise version has no
     fine-grained tokens.
   - **Forgejo / Gitea:** *Settings → Applications → Generate new token*,
     with *repository: Read and write* (`write:repository`). Forgejo has no
     per-repository tokens, so consider a dedicated backup user that can
     only write to this one repository.
   - The token's owner needs write access to the repository; on a
     protected branch the push is refused, so use an unprotected branch
     (e.g. `labber-backup`) if `main` is protected.
3. In **Settings → Backup**, fill in:
   - the repository URL (`https://github.example.com/team/labber.git`,
     `https://git.example.com/home/lab-backup.git`)
   - the branch (`main`)
   - the folder: one name per labber instance, e.g. `labber-prod`
   - the token
4. **Test connection** checks that the token can see the repository and
   push to it. It warns if the repository is public.
5. **Back up now** makes the first backup. In an empty repository, a
   first commit with a README is made automatically.

### Self-signed servers

If the server uses a self-signed certificate (or one from a private CA):

- **Preferred:** paste the server's certificate, or its CA, in PEM form
  under **Trusted certificate**, and keep **verify** ticked. Get it with
  `openssl s_client -connect github.example.com:443 -showcerts </dev/null`.
- **Or** untick **verify the server's TLS certificate**. The backup still
  works, but nothing checks who is on the other end, and the token travels
  over that connection.

labber connects to the repository directly; an HTTP proxy is not supported.

## Schedule

The default is **monthly** on the 1st at 02:00; it can also be weekly
or off (manual only).

- **Time zone:** the time is the **server's** local time. That is the
  container's `TZ`, which is UTC unless set. The panel shows which zone
  it is.
- **Missed slots:** if labber was down at that moment, the backup runs
  shortly after it starts again. Only the most recent missed slot runs,
  never a backlog.
- **Failures:** a failed scheduled backup is not retried until the next
  slot. The failure shows under **Last backup** and in the activity log;
  use **back up now** to run one by hand.

**Dashboard warning:** while backups are scheduled, the dashboard shows a
banner when the last backup failed. It also shows one when there has been
no good backup for 40 days (monthly) or 10 days (weekly), counted from the
last good backup, or from when backups were set up. Nothing is shown for
manual-only backups.

Every backup, scheduled or manual, is recorded in the activity log as
`backup.run`, with the commit. Changing these settings is recorded as
`backup.settings`. The token itself is never logged.

## Restoring

Restore into labber's data volume (`LABS_DIR`) while labber is stopped:

```sh
git clone https://github.example.com/team/labber.git && cd labber/<folder>
cp labs/*.lab.yml               "$LABS_DIR"/
mkdir -p "$LABS_DIR/.runbooks" "$LABS_DIR/.audit"
cp -R runbooks/.                "$LABS_DIR/.runbooks/"
cp activity/*.jsonl             "$LABS_DIR/.audit/"
```

Then start labber and finish the restore in the UI:

- **Settings:** re-enter the Proxmox connection (token and password),
  using `settings/proxmox.json` for the rest.
- **Store:** re-create the Store entries the labs and runbooks use (the
  backup has none of them).
- **Users:** re-add users (names are in `settings/users.json`).
- **Backup:** re-enter the backup token.

**Deployed labs:** only copy `state/*.json` to `$LABS_DIR/.state/` if those
VMs still exist on the same Proxmox. Otherwise leave it out, and deploy the
labs again.

To bring back a single lab, take its file from `labs/` (or from an older
commit) and use **import lab** in the labs window.
