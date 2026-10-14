# Changelog

## 0.4.0

### Added
- **Activity log** (Settings -> Activity): every change made in the app --
  who, when, from which address, and how it ended (ok / failed / denied /
  aborted). Lab saves, deploys, destroys, bootstraps and updates; node power,
  mgmt IP and identity; consoles opened and for how long; runbook runs,
  aborts and edits; Store, settings, template, user and token changes;
  changes sent through the API relay (under the token's label); sign-ins,
  failed sign-ins and lockouts. Values are never logged (no passwords or
  secrets, nothing typed in a console), and nothing in the app can edit or
  delete an entry. Filter by text, user, kind and date; export to CSV.
  - Kept as one file per day in `<LABS_DIR>/.audit/` for
    `AUDIT_RETENTION_DAYS` (default 90), and printed to stdout as
    `audit {...}` lines so the container log keeps its own copy
    (`AUDIT_STDOUT=off` to stop that).
  - **most active**: changes per user as a chart -- labs, runbooks, consoles
    and other changes -- for the last 7 days, 30 days, all time or all three,
    with a table view.
  - The labs window shows each lab's last few changes and who made them,
    with a link to its full activity.
- **Backups to a Git repository** (Settings -> Backup): labs, every runbook
  version, the activity log and settings without their secrets, committed to
  a folder of a GitHub, GitHub Enterprise Server or Forgejo / Gitea
  repository -- one commit per backup, so the repository's history is the
  backup history. Monthly by default (or weekly), plus "back up now".
  - Never included: the Store, the Proxmox token / password, password and
    API-token hashes, the backup token.
  - The server type is detected; no user name is needed. A self-signed
    server can be trusted by pasting its certificate, or TLS verification
    can be switched off.
  - The dashboard warns when the last backup failed, or when there has been
    no good backup for 40 days (monthly) / 10 days (weekly).
  - docs/BACKUP.md, including how to restore.
- **Lab export, import and duplicate** (labs window): export the saved lab
  file as an exact copy, or a clean copy without node uuid / mac pins and
  management IPs; import a `.lab.yml` as a new lab, with a list of the
  templates, runbooks and Store entries it needs that this labber lacks;
  duplicate a lab as a new, clean copy. None of them ever replaces a lab.
- `npm test`: the first tests in the repository (`test/`, Node's built-in
  runner, no new dependencies). They are not part of the container image.

### Changed
- **Runbook library**: one card per runbook, showing its default version
  (the one a lab or run uses when it names none: highest locked, else highest
  draft) and any newer drafts; older versions fold away and stay runnable.
  Hover a version's description for its changelog.
- `f5-load-config` 1.3: waits for the F5 to answer again after applying the
  configuration, and retries the save. A config that restarts the F5's REST
  service while it loads got "HTTP 502 Proxy Error" from 1.2's save.

### Upgrading
- Nothing to do: no new settings are required, and existing labs, runbooks,
  Store entries, users and settings are read as they are. An upgrade from
  0.3.3 and a rollback to 0.3.3 were both tested on the same data volume.
- New optional environment variables: `AUDIT_RETENTION_DAYS`,
  `AUDIT_STDOUT`.
- Bootstrap entries that name no version now get `f5-load-config` 1.3 (unless
  you locked an older version).
- The volume gains `.audit/` (the activity log) and, once backups are set up,
  `.config/backup.json`.

## 0.3.3

### Added
- **Rebuild an F5 HA pair to the state it was in.** Export each member of a
  working sync-failover pair, destroy the lab, and its lab file brings the
  pair back -- configs, encrypted values, device trust, device group, sync --
  with no manual steps. Verified on BIG-IP 17.5.1.5 with LTM + ASM. See
  docs/RUNBOOKS.md "Rebuilding an F5 HA pair" and
  `labs/f5-ha-pair-restore-example.lab.yml`.
  - `f5-set-master-key` (new): gives a fresh BIG-IP the master key saved by
    the export, so encrypted values (monitor passwords, key passphrases, ASM
    bot-signature data) load as they are. Run it before provisioning ASM.
  - `f5-cluster-pair` (new, 1.3): names each device after its hostname, sets
    the config-sync / failover / mirror addresses, builds device trust
    (reset, retry while F5's device management restarts, confirm), creates
    the sync-failover group, syncs, and waits until both nodes read In Sync
    and one is ACTIVE, the other STANDBY. Safe to run again.
  - `f5-export-config` 1.3: cluster members export cleanly (folder
    device-group lines, datasync and ASM device-sync objects left out),
    optional master-key capture into a secret Store entry, the source's
    cluster settings recorded as comments.
  - `f5-load-config` 1.2: tidies the same cluster-only references on the F5
    before checking the file, so configs exported earlier load too.
- **Bootstrap `waitFor: <node>`**: an entry waits until other nodes have
  finished their bootstrap (loops are refused when the lab file is checked).
  A second node input takes a node name: `inputs: { peer: f5-2 }`.
- Template filter `| sha512crypt` (a salted `$6$` password hash, masked in
  logs like the secret itself).
- Store writes from runbooks can be `type: secret` (only replacing a secret
  in the runbook's own group); http `extract` rules can be `secret: true`.

### Fixed
- **Check Point `checkpoint-first-time-config` 1.4** now configures a fresh
  Gaia clone end to end (verified on R82): the expert password is set with
  `set expert-password-hash` and saved; while waiting for the expert prompt
  it presses Enter (Gaia loses the Enter sent with the password); answers the
  reboot confirmation. `config_system` uses its documented long options;
  `install_ppak` is gone. `checkpoint-sms-add-gateway` / `-cluster` 1.2 get
  the same expert-login fix.

### Upgrading
- Built-in runbooks are seeded as new versions; your existing versions are
  never overwritten. If you locked an older version, "latest" keeps using it
  until you lock the new one -- or pin `version:` in the lab file.

## 0.3.2

### Fixed
- **Runbooks could store a value cut off mid-arrival** from the console: output
  arrives in pieces, so an expect with `as:` could keep `192.0.2.1` while the
  rest of `192.0.2.147` was still on its way (seen with a DHCP management IP),
  or a return code of `1` instead of `127`. A capture that ends at the last
  character received is now only accepted once the output pauses (1.5 s); the
  line's own newline normally settles it at once. Fixes every runbook,
  built-in or your own, with no new runbook versions. Expects without `as:`
  are unchanged.

## 0.3.1

### Fixed
- **web rp behind nginx / NPMplus returned 502** for F5, Palo Alto and Panorama:
  pages the proxy edits were sent with both `Content-Length` and
  `Transfer-Encoding`, which nginx rejects (HAProxy and Traefik tolerate it).
  Replies are now framed cleanly, with no hop-by-hop headers from the device.
- A device dropping the connection mid-reply no longer leaves the browser
  waiting: the frame shows an error page, or the reply ends at once.
- The web rp's cache of edited PAN-OS files no longer stores `Set-Cookie`, so
  a cookie meant for one user is never served to another.

### Docs
- nginx / NPMplus settings for the web rp host (header buffers, timeout).

## 0.3.0

### Changed
- **Node 24** (was Node 20, now end-of-life). Measured on the same workload:
  API ~15% faster, static files ~2x, same start-up. Connections to lab
  appliances keep Node 20's TLS tolerance (1024-bit DH still works).
- **web rp is a more transparent proxy**: the device's own origin is sent as
  Origin (requests and websockets), redirects to the device's own address stay
  on the proxy, cookies become host-only. Readable error pages inside the frame.
  New maximize and pop-out buttons on the embedded window.
- Large files split along their features (deploy, lab state, dashboard cards,
  new-lab wizard, web rp proxy) with no change in behavior.

### Added
- **Template editor** (Settings -> Templates): every kind's versions, the
  default, which labs use each; add a template built by hand in Proxmox, make
  default, rename, remove (mapping only), check it suits its kind, edit hw.
- **Template uploads check first**: file type for the kind, version conflict,
  storage content types, free space, VMID -- before any multi-GB upload.
- **Check Point** from one Gaia template: runbooks to move a clone off the
  install-time IP, set interfaces, run the first-time configuration as
  standalone / gateway / cluster member / management server, and have the
  management server add gateways and ClusterXL clusters. Guide and five sample
  labs in docs/CHECKPOINT.md (runbooks are drafts until run on your Gaia).
- `GET /healthz` and a container HEALTHCHECK; a dashboard banner when Proxmox
  can't be reached or isn't configured.
- Runbook engine: `fail` step, `when` lists (all must hold), templated `equals`.

### Fixed
- Staged template images are removed from Proxmox after import (they stayed
  forever); concurrent template builds no longer pick the same VMID; ISO
  templates no longer keep the installer ISO attached (finalize refuses while
  the VM is still running).
- "edit hw" failed for templates without a SCSI controller (e.g. Nexus 9000v).
- Removed or renamed template versions could reappear after a restart.
- Higher-contrast dim text; README: the web rp listener answers 404 (it always
  starts) when no GUI domain is set.

### Upgrading
- No data migration: keep the /labs volume. Back it up first, pin `:0.3.0`,
  keep `:0.2.2` to roll back to (it reads everything 0.3.0 writes; only the new
  Check Point runbooks wouldn't run there).
- The container image stays two-stage and arm64-safe; all dependencies are
  pure JavaScript.

## 0.2.2

### Fixed
- **The live deploy / bootstrap log no longer freezes behind a reverse
  proxy.** A long quiet runbook step (an appliance still booting) let the
  proxy drop the log's WebSocket while the work carried on. The server now
  pings every WebSocket every 25 s, bootstrap prints `still running "<step>"`
  once a minute during a long step, and a connection that still drops
  reconnects and is replayed everything it missed. Selecting a lab also shows
  its latest operation's log.
- **`f5-first-boot` read the DHCP address only once** and failed when the
  network service was still restarting after the login. It now waits up to two
  minutes for the address. The same fix ships as `f5-first-boot-dhcp`, a new
  runbook name, so an existing library gets it without editing `f5-first-boot`.
- Library seeding never overwrites an existing runbook version, so edit your
  copy of `f5-first-boot` (replace the "Read the management IP" step) or use
  `f5-first-boot-dhcp`.

### Added
- `f5-first-boot-finish`: finishes a first boot that stopped after the
  password change (reads the IP, saves, stores it on the node). Running
  `f5-first-boot` again cannot work at that point.
- `docs/RUNBOOKS.md`: how resume works (progress is the count of finished
  entries in a node's `bootstrap:` list, so an entry can be swapped in place).

### Changed
- **Much less load on Proxmox and the browser.** One Proxmox call per
  dashboard refresh instead of one per node (shared for 2 s between the status
  and stats endpoints and every open tab); Proxmox connections are pooled;
  the Runs tab re-reads only changed run files; lab files are parsed once per
  change; hidden browser tabs stop polling; responses are gzip-compressed; the
  lab log terminal is built only when there is output to show.
- Dependency security updates (`npm audit` is clean): express, multer,
  js-yaml, undici, qs and proxy-addr, within the same version ranges.

### Container image
- The two-stage, arm64-safe Dockerfile from 0.2.1 is unchanged. The new
  dependency (`compression`) and the updated ones are pure JavaScript, like the
  rest, so the build still installs them on the build machine and copies the
  result; nothing runs under QEMU emulation. Keep that Dockerfile as it is.

## 0.2.1

### Fixed
- The container image failed to build for arm64 on GitHub Actions: Node
  crashed with "Illegal instruction" while installing packages under
  emulation. The Dockerfile is now a two-stage build that installs the
  (pure JavaScript) dependencies on the build machine and copies the result,
  so no step runs under emulation. 0.2.0 has the same code but no published
  image; use 0.2.1.

## 0.2.0

### Added
- **Runbooks** — reusable, versioned device automation: serial-console
  steps (`expect`/`send`/`paste`), REST/XML API steps with polling, retries
  and chunked uploads, steps that save a node's management IP or write to
  the Store. Draft / locked versions, "new version" and "copy as", and a
  live run view with the node's console. See `docs/RUNBOOKS.md`.
- **Store** — named passwords, text and per-node licenses (registration
  key, license text, UUID + MAC), with edit history and usage checks.
- **Lab bootstrap** — per-node runbooks in the lab file run after deploy
  (nodes in parallel), with resume-after-failure, rollback of failed
  builds, and lab `vars:` for copy-and-repoint labs.
- **Shipped runbooks** (drafts): F5 BIG-IP first boot (DHCP or static),
  web password change, Setup Utility, license, module provisioning, config
  export and load; FortiGate, FortiManager, PAN-OS/Panorama, Nexus 9000v,
  Catalyst 8000V and Cisco FTD/FMC first boot and config load.
- **Console lock** between runbooks and people, with explicit take-over.
- **Presence** indicator and **lab reservations** (non-blocking notices).
- Settings → About panel; `tools/scf-repair.py` for stored F5 configs.

### Changed
- Terminal panes are bottom-aligned and refit when their container
  resizes (no more half-clipped last line).
- Request bodies up to 10 MB; Store values up to 5 MB.

### Fixed
- Web-rp hostnames are matched case-insensitively (labs with capitals).
