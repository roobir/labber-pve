# labber-pve

A YAML-defined network/security lab builder for **Proxmox VE** -- clone
golden VM templates (Palo Alto PAN-OS/Panorama, Check Point, F5, etc.),
wire them together with auto-provisioned Linux bridges, and get a
browser-based console + live status dashboard, all driven by the Proxmox
REST API directly rather than a hand-rolled libvirt wrapper.

This is the spiritual successor to an earlier libvirt-based version of this
tool (which drove `virt-install`/`virsh` against a host's raw libvirt
socket). labber-pve does the same job through Proxmox's own API instead,
which means:

- **Console access and per-VM status come from Proxmox itself** (its
  `termproxy`/`vncwebsocket` endpoints, the same ones its own web UI uses)
  instead of a custom noVNC/SSH bridge.
- **Cloning is Proxmox's own linked-clone feature**, not hand-managed qcow2
  overlay files -- no more "bind-mount at the exact same absolute path on
  host and container" gotcha from the libvirt-based version.
- **No host socket mount, no privileged container.** This app is a plain
  HTTPS API client -- it can run anywhere with network access to your
  Proxmox node: Docker, Podman, a k3s/k8s cluster, or OpenShift, without
  being tied to running on the hypervisor itself.

The dashboard reuses a companion containerlab-based project's dark-terminal
aesthetic and interaction patterns (single-user session auth, xterm.js
console modal, YAML editor + live deploy/destroy output) -- same look, same
feel, different backend underneath.

## Status

Early scaffold, not yet run against a real Proxmox node. A few things are
flagged in code comments as needing empirical verification rather than
presented as guaranteed-correct:

- `network-manager.js` / `proxmox-client.js`'s `applyNetworkChanges()` --
  the exact call to apply pending bridge changes on a node wasn't
  independently confirmed against the official API schema (only
  community references).
- `console-bridge.js`'s termproxy/vncwebsocket handshake -- confirmed
  against a real Proxmox node that API tokens are **not** accepted for this
  one endpoint category (Proxmox bugzilla #6079: "does not look like a
  valid user name" / "connection closed before authentication"), even
  though the token works fine everywhere else in this app. Console access
  now needs a real Proxmox username+password configured in Settings
  ("Console access" section) alongside the API token -- used only to get a
  session ticket (`PVEAuthCookie`) for termproxy/vncwebsocket, nothing else.
  The handshake itself is also now `username:ticket\n` (not the bare
  ticket), and the termproxy request sends a `Referer` header with
  xterm.js's query params, both confirmed from Proxmox forum threads
  describing this exact failure. The vncwebsocket channel's own framing is
  now also confirmed against Proxmox's real `pve-xtermjs` client: everything
  the *client* sends uses numbered prefixes -- `0:<byte length>:<data>` for
  regular input, `1:<cols>:<rows>:` for resize (this one already happened to
  match), `2` alone for a keepalive ping (not currently sent -- if a console
  session seems to drop after sitting idle for a while, that's the first
  thing to add). Output from termproxy back to the client is plain,
  unframed bytes -- no special handling needed there. Missing the input
  framing was the actual bug behind a real, empirically-confirmed failure:
  connection/auth/output all worked, but nothing typed ever reached the VM.
- `template-builder.js` / `proxmox-client.js`'s `uploadImportFile()` and
  `importDisk()` -- the `content=import` upload + `import-from=` disk-attach
  flow is grounded in Proxmox's own Import Wizard/storage-import API (PVE
  8.1+), not hand-waved, but hasn't been run end-to-end against a real node
  in this environment. Two specific things worth confirming on first use:
  whether the upload/import calls return a real UPID task (handled either
  way via `maybeWaitForTask()`, but worth watching the first run), and
  whether your PVE version's "Import" content type needs to be enabled on
  the storage explicitly (Datacenter > Storage > *storage* > edit > Content)
  even though `template-builder.js` requests it as part of storage creation.

Everything else (clone, VM config/networking, start/stop/delete, task
polling, auth, the console/lab websocket bridges) is grounded in Proxmox's
documented API shape.

## Architecture

```
lib/
  config-store.js      -- persisted Proxmox connection + template settings (Settings page)
  proxmox-client.js    -- thin HTTP wrapper over the PVE REST API + async task polling
  network-manager.js   -- per-link vmbr bridge naming/provisioning (15-char IFNAMSIZ safe)
  vendor-profiles.js   -- device kind -> golden template VMID + VM hardware profile
  template-builder.js  -- uploaded qcow2 -> golden template, via PVE's import-from
  lab-manager.js        -- YAML-driven deploy/destroy orchestration + state tracking
  console-bridge.js     -- websocket proxy: browser <-> PVE termproxy/vncwebsocket
  lab-bridge.js          -- websocket: streams deploy/destroy progress to the dashboard
  gui-proxy.js            -- second HTTP listener: Host-header-routed reverse proxy
                             for embedding a node's own web UI in-dashboard
  api-relay.js            -- path-routed reverse proxy on the main app port for
                             automation/API clients (curl, scripts, CI) -- see
                             "API relay" section below
  api-tokens.js           -- bearer tokens gating api-relay.js
  auth.js               -- session-based multi-user auth
public/                 -- dashboard frontend (dark-terminal aesthetic)
labs/                   -- your *.lab.yml topology files live here (bind-mounted/PVC'd in)
k8s/                    -- Deployment/Service/PVC/Secret-template for k3s or OpenShift
```

## Remote stats API (optional, for external dashboards)

Settings has a toggle for a read-only, **unauthenticated**
`GET /api/public/stats` endpoint, plus an optional comma-separated IP
allowlist. Off by default -- with the toggle off the endpoint 404s, same as
if the route didn't exist at all. This is what lets an external site (e.g.
a homepage's lab-status widget) show lab stats without needing a login of
its own; logged-in users always see the identical data at
`GET /api/stats` regardless of the toggle -- it also backs the dashboard's
own stats-bar CPU/mem/disk tiles.

Response shape (both endpoints) is deliberately identical to the old
libvirt-based labber's own `/api/public/stats` -- home-website's
`telemetry.php` (`get_lab_data()`) already knows how to read this shape, so
pointing its `LAB_HOST` constant at wherever labber-pve is hosted is the only
change needed there, no PHP edits:

```json
{
  "labs": [
    { "name": "pa-panorama-test", "file": "pa-panorama-test.lab.yml", "active": true, "runningNodes": 3, "totalNodes": 3 }
  ],
  "labsTotal": 4,
  "labsActive": 1,
  "vmsRunning": 3,
  "vmsTotal": 3,
  "host": {
    "cpu_count": 16,
    "cpu_percent": 4.2,
    "load": { "1m": 0.42, "5m": 0.31, "15m": 0.28 },
    "memory": { "total_mb": 65536, "available_mb": 40000, "used_mb": 25536, "used_pct": 39.0 },
    "disk": { "path": "Labber", "total_gb": 1863, "used_gb": 210, "free_gb": 1653, "used_pct": 11.3 }
  }
}
```

`labs[].active` is `true` when at least one node from that lab file is
currently `running`. Unlike old labber (which read `/proc/loadavg` and
`/proc/meminfo` directly, since its engine ran on the libvirt host itself),
`host.*` here comes from the **Proxmox node's own API**
(`GET /nodes/{node}/status`) via `lib/host-stats.js`, polled every 10s and
cached -- consistent with this app never needing host access. `host.disk` is
specifically the **configured disk storage's** usage
(`GET /nodes/{node}/storage/{storage}/status`), not the node's root
filesystem, so it reflects what lab clones/templates actually consume; falls
back to rootfs if no disk storage is configured yet. `cpu_percent` is an
extra field beyond old labber's shape (PVE reports it natively) -- ignored
by anything only expecting `host.load`/`host.cpu_count`.

Settings are stored in `LABS_DIR/.config/api-settings.json` (same volume and
0600/0700-perm pattern as `proxmox.json`).

## API relay (automation gateway, optional)

Settings -> Public API also has an **API relay** toggle, for the opposite
problem the stats API solves: instead of a read-only summary for an
external dashboard, this lets your own automation (curl, Ansible, a CI
pipeline, whatever) reach a lab node's *real* management API through this
app, without needing a VPN/route into the lab's own management network from
wherever that automation runs.

```
curl -H "X-Labber-Relay-Token: lbr_...token..." \
  -H "Authorization: Bearer <fgt1's own API token>" \
  https://labber.example.com/api/relay/the-big-lab/fgt1/api/v2/cmdb/system/status
```

is forwarded, byte-for-byte (including that `Authorization` header, meant for
`fgt1` itself, not this app), to:

```
https://<fgt1's mgmt IP>:<fgt1's mgmt port>/api/v2/cmdb/system/status
```

Node lookup uses the exact same deployed-lab-state resolution as the
dashboard's own "web ui"/"web rp" buttons (`lib/lab-state.js`'s
`getNodeTarget()`) -- a node needs a mgmt IP saved on its dashboard card
before its relay path resolves to anything.

**Deliberately just a relay, not a full gateway with stored device
credentials.** This app does not know or store each device's own admin
username/password -- your request needs to carry whatever auth the device
itself expects (HTTP basic auth, an API key header, a bearer token from
that vendor's own login flow, ...) exactly as if you were calling it
directly. That's also why the relay's own token rides in a dedicated
`X-Labber-Relay-Token` header rather than `Authorization`: many vendor REST
APIs (BIG-IP iControl, PAN-OS, FortiOS) expect `Authorization` for their own
credential, and reusing it for this app's token would clobber that. What
this relay *does* solve is reachability and having a single stable
hostname/token in front of every lab, rather than device credential
management -- if you want labber-pve to also inject stored per-device
credentials on your behalf, that's a real but separate feature (would need
its own encrypted secret store per node).

This is a different code path from **web rp** (`lib/gui-proxy.js`)
deliberately: gui-proxy exists to make a vendor's UI survive being embedded
in a browser iframe (stripping `X-Frame-Options`, rewriting cookie
`SameSite`, one vendor-specific HTML patch) -- none of that is meaningful,
and some of it would be actively wrong, for a scripted API client. The
relay does zero header/body rewriting; what you send is exactly what the
device receives.

Setup:

1. Settings -> Public API -> check **enable API relay**, save. Off by
   default -- with it off, every `/api/relay/*` request 404s, same "off
   means the route doesn't exist" pattern as the stats API.
2. Same panel, **create a token** -- give it a label, and optionally a **lab
   scope** (restricts that token to one lab's nodes only; blank = any lab
   this app knows about). The raw token is shown exactly once at creation
   time -- copy it immediately, it can't be recovered later, only revoked
   and reissued.
3. Send it as `X-Labber-Relay-Token: <token>` on every relay request --
   deliberately not `Authorization`, so that header stays free for the
   target device's own credential (see below).

No new DNS/cert/Ingress setup needed (unlike **web rp**'s wildcard
subdomain) -- `/api/relay/*` is just a path on this app's own existing
hostname/port. Tokens are stored in
`LABS_DIR/.config/api-tokens.json` (bcrypt-hashed, same volume/perm pattern
as `users.json`).

**Not yet covered**: devices that are CLI/SSH-managed rather than
REST-API-managed (e.g. `cisco_n9kv`'s NX-OSv has no primary HTTPS API) can't
be reached through this relay -- it's HTTP(S)-only. An SSH-based relay/jump
host for those, and for bulk config-push workflows, would be a separate
addition (`ssh2`-based, not yet built).

## Disk storage + building templates from a qcow2

Golden templates no longer have to be hand-built by installing an OS/appliance
once and running `qm template`. The **templates** button in the header uploads
a qcow2 (or raw/vmdk) straight from the browser and turns it into a Proxmox
template, entirely through the PVE API -- no SSH or host filesystem access,
consistent with this app's "plain HTTPS API client" design.

How it works (`lib/template-builder.js`):

1. The file is staged on the configured disk storage's `import` content type
   (`POST /nodes/{node}/storage/{storage}/upload`, `content=import`).
2. A bare VM is created with that device kind's hardware profile (bios,
   machine type, CPU, cores/memory, disk bus, scsi controller, NIC count) --
   see `vendor-profiles.js`'s `hw` blocks.
3. The staged image is attached as that VM's disk via
   `import-from=<storage>:import/<file>` -- Proxmox itself does the
   qcow2 -> target-format conversion during this step.
4. The VM is converted to a template (`qm template` equivalent) and its vmid
   is saved as that kind's template on the Settings page, same as if you'd
   typed it in by hand.

The per-kind hardware profiles in `vendor-profiles.js` are sourced from
known-working hand-built VMs on this project's own Proxmox node (Palo Alto
PAN-OS/Panorama, Check Point Gaia, FortiGate, FortiManager, Cisco Nexus
9000v/Catalyst 8000V -- the latter two from this homelab's older
libvirt-based `labber` project's own trial-and-error notes, not this node
directly). F5 BIG-IP VE has no such reference yet -- its defaults are a
reasonable guess; edit `STATIC_PROFILES` directly if they don't match what
actually boots.

Two hardware-profile fields worth knowing about beyond the obvious ones:
`nicModel` (default `virtio`) -- Nexus 9000v needs `e1000` specifically,
both for its mgmt interface and data plane; and `scsihw` being optional --
a SATA disk bus (also Nexus 9000v) needs no SCSI controller type at all.

### Building from an install ISO instead of a qcow2

Not every appliance ships a ready-to-boot qcow2 -- Check Point Gaia is
built from the vendor's install ISO instead (`installFromIso: true` on its
profile), same as this project's own hand-built `cp-fw-01`/`cp-fw-02`
originally were. The **templates** modal accepts `.iso` alongside
qcow2/img/raw/vmdk; for an ISO-flagged kind, an extra "disk size (GB)"
field appears (defaults to 65GB, matching this project's real Check Point
VMs). The build creates a blank disk of that size, attaches the ISO as a
CD-ROM (`ide2`), sets boot order to disk-then-CD-ROM (`order=scsi0;ide2;net0`,
matching those same real configs), and starts the VM -- then stops at an
**awaiting-install** status instead of auto-templating, since finishing the
interactive Gaia installer over console is a real manual step no upload
alone can skip. Once you've completed the installer and shut the VM down,
click **finalize as template** in the same modal (`POST
/api/templates/finalize`) to convert it, same as the automatic qcow2 path
does at the end.

### Disk storage setup (one-time, in Proxmox)

Pick where template + lab disks should live via the Settings page's **Disk
storage** section:

- **Use an existing storage as-is** -- just pick it from the dropdown.
- **Carve a new directory storage out of an existing mount** -- e.g. you
  already have a storage `Storage` mounted at `/mnt/pve/Storage` (a 2TB SSD)
  and want a dedicated `Labber` storage at `/mnt/pve/Storage/labber` just for
  this app. Pick `Storage` as the parent, type `Labber` / `labber`, and
  **create storage** -- this calls Proxmox's own storage API
  (`POST /storage`, `type=dir`, `create-base-path=1`), which creates the
  subdirectory and registers the new storage for you. No manual `mkdir` or
  `pvesm add` needed.

One real constraint: the `import` content type used for staging uploaded
images only works on **directory-backed** storage (dir/NFS/CIFS), not
LVM-thin/ZFS block storage -- so the drive backing whatever storage you pick
here needs to be formatted with a real filesystem and mounted (or already is,
if it's an existing storage). The same storage doubles as the final home for
template and clone disks (content types `images` + `import` both enabled by
default when created through the app).

## Lab YAML schema

```yaml
nodes:
  panorama1:
    kind: paloalto_panorama   # must match a key in lib/vendor-profiles.js
  pa-fw1:
    kind: paloalto_panos
    cores: 8                 # optional -- overrides just this node's clone, template's own hw is untouched
    memory: 16384             # optional, MB
    full: true                 # optional -- independent full clone instead of the default linked clone

links:
  - name: mgmt
    external: true            # reuse an existing bridge instead of provisioning one
    bridge: vmbr0
    endpoints:
      - { node: panorama1, interface: net0 }
      - { node: pa-fw1, interface: net0 }

  - name: inside               # no `external:` -> auto-provisioned isolated bridge
    endpoints:
      - { node: pa-fw1, interface: net1 }
      - { node: pa-fw2, interface: net1 }
```

Any NIC slot a node has (per its vendor profile's `nics` count in
`vendor-profiles.js`) that isn't referenced by any link's `endpoints` is
left explicitly link-down at deploy time, not silently bridged onto
whatever the golden template's placeholder network is -- see the wizard's
"Interface map" panel for a live view of this per node before deploying.

See `labs/pa-panorama-test.lab.yml` for a full example. The **labs** modal's
**+ new lab** button builds this same file through a form instead -- pick node
kinds, then wire endpoints together for each link (or mark a link external and
pick from your node's actual existing bridges -- `GET /api/bridges`
discovers every real `vmbrN` interface plus its comment, so a node with
several already hand-built for different VLANs/uplinks can be picked by
name instead of typed blind; a "+ new bridge" button next to the picker
creates one on the spot if none of the existing ones fit) -- for a first lab
you'd rather not hand-write YAML for. It POSTs to `/api/labs` (`lab-manager.js`'s `createLab()`,
distinct from the existing `PUT /api/labs/:name` used to edit a file that
already exists, so the wizard can never silently overwrite a hand-edited
lab of the same name). Once created it's a completely normal `.lab.yml` --
still editable by hand in the same modal afterward.

## Node mgmt IP + browser access to a node's web UI

Proxmox has no equivalent of libvirt's dnsmasq DHCP-lease table (what the
old libvirt-based `labber` project used for automatic IP discovery), so a
running node's mgmt IP is either detected via the QEMU guest agent or
entered by hand -- both live on each running node's dashboard card:

- **Detect**: every clone gets `agent: 1` set on it automatically at deploy
  time, which lets Proxmox *attempt* a `guest-agent network-get-interfaces`
  call. This only actually returns anything if `qemu-guest-agent` is
  installed and running **inside** the guest -- true for general-purpose
  Linux/Windows VMs, but **not expected to work for most of this app's
  vendor appliance images** (FortiOS, PAN-OS, Check Point Gaia, Cisco
  NX-OSv/IOS-XE/FTDv/FMCv, F5 BIG-IP -- closed appliance OSes, not
  general-purpose guests with a package manager to install it on). Click
  **detect** to try; if nothing comes back, that's expected for most of
  these images, not a bug.
- **Manual entry**: always available regardless -- type the IP a node
  actually landed on (e.g. from a DHCP-serving `vmbr` you wired its `net0`
  to) and **save**. Persisted per-node in that lab's own deploy state
  (`LABS_DIR/.state/<lab>.json`), so it survives dashboard reloads but is
  cleared the same way vmid/bridge state is on `destroy()`.

Once an IP is set, a running node's card shows two ways to reach its web
UI:

- **web ui** -- opens `https://<ip>:<port>/` directly in a new tab. Works
  with no further setup, straight to whatever network the node's mgmt
  interface is actually on (needs your own machine to have a route there,
  same as reaching it any other way).
- **web rp** ("web reverse proxy") -- opens the same UI in an in-dashboard
  `<iframe>`, only shown once a **GUI domain** is configured (Settings ->
  "Embedded GUI proxy"). Requires additional one-time setup, since embedding needs to strip
  `X-Frame-Options`/CSP headers most vendor UIs send (confirmed on Palo
  Alto Panorama) and a raw-IP iframe can't get past a self-signed-cert
  warning the way a new-tab navigation can:
  1. A wildcard DNS record: `*.<GUI domain>` (e.g. `*.gui.labber.example.com`)
     -> wherever your reverse proxy/Ingress lives.
  2. A reverse-proxy/Ingress rule forwarding that same wildcard host to
     this app's `lib/gui-proxy.js` listener -- a second HTTP server,
     separate from the main app port, `GUI_PROXY_PORT` env var (default
     `8081`). It Host-header-routes `<labName>--<nodeName>.<GUI domain>` to
     that node's live mgmt IP (resolved from deployed lab state on every
     request, not cached), strips the framing-blocking headers on the way
     back, and 404s for anything it doesn't recognize -- same "off means it
     behaves like the route doesn't exist" pattern as the public stats API.
  3. Attach/request a TLS cert covering `*.<GUI domain>` wherever that
     reverse proxy terminates TLS (the proxy itself speaks plain HTTP --
     whatever fronts it is assumed to already be the real TLS termination
     point, same reasoning as npmplus terminating TLS in front of the main
     app).
  4. Set the **GUI domain** field in Settings to that same value.

## Security model (read before exposing this to a network)

This app holds Proxmox API credentials and brokers access to lab appliance
management interfaces, so it is worth being explicit about what is and isn't
protected.

**Protected by the dashboard login.** Every `/api/*` route, the lab
deploy/destroy actions, the console bridge, and both websocket endpoints
require a session from a bcrypt-verified account in `.config/users.json`.
Failed logins are throttled per source IP (`LOGIN_MAX_ATTEMPTS`,
`LOGIN_LOCKOUT_MINUTES`).

**The embedded-GUI reverse proxy is deliberately unauthenticated.** When
`guiDomain` is set, `lib/gui-proxy.js` listens on `GUI_PROXY_PORT` and
forwards `<lab>--<node>.<guiDomain>` straight to that node's management
interface, stripping `X-Frame-Options` so it can be embedded in an iframe.
It has no session check -- it can't have one, because the browser loads it
from a different hostname than the dashboard's own cookie is scoped to.

In practice that means **anyone who can reach that port and resolve that
hostname gets the appliance's own login page.** They still need the
device's credentials to get further, but you should treat the GUI proxy as
"exposes lab management UIs to whoever can reach it" and place it
accordingly: an internal network, behind a VPN, or behind an
authenticating reverse proxy. Leave `guiDomain` empty and the listener
never starts at all.

**The public stats API and the automation relay are off by default.**
`/api/public/stats` requires an explicit opt-in plus an optional IP
allowlist; `/api/relay/*` requires an opt-in *and* a bearer token
(bcrypt-hashed at rest, shown once, individually revocable, optionally
scoped to one lab).

**IP allowlists depend on a trusted proxy.** The allowlist reads
`X-Real-IP` / `X-Forwarded-For`, which any client can send. It is only
meaningful behind a reverse proxy that *overwrites* those headers. Set
`TRUST_PROXY=1` when running behind exactly one such proxy -- that also
lets the session cookie mark itself `Secure` automatically on HTTPS.

**Credentials at rest.** Proxmox tokens, the console username/password,
user password hashes and relay token hashes live in JSON files under
`$LABS_DIR/.config` with `0600`/`0700` permissions. They are not encrypted
at rest; secrets are never echoed back to the browser once saved.

**TLS to appliances is not verified** (`rejectUnauthorized: false`), because
self-signed certificates are the norm on lab appliance management
interfaces. Both proxies and the direct "web UI" links share that trust
model.

## Setup

Only the dashboard's own login secrets are required to boot the app at all
-- Proxmox connection details and template VMIDs are configured **after**
first boot, from the Settings page in the header, and take effect
immediately (no restart) since they're read fresh from a persisted config
file (`LABS_DIR/.config/proxmox.json`, `0600` perms, never committed) on
every API call rather than baked in at process start.

1. Generate the two dashboard secrets:
   ```bash
   node -e "console.log(require('bcryptjs').hashSync('yourpassword', 10))"   # DASHBOARD_PASSWORD_HASH
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # SESSION_SECRET
   ```
2. Run it with just those two set (Docker/Podman):
   ```bash
   docker build -t labber-pve .
   docker run -e DASHBOARD_PASSWORD_HASH=... -e SESSION_SECRET=... \
     -p 8080:8080 -v ./labs:/labs labber-pve
   ```
   k3s/OpenShift: `kubectl apply -f k8s/pvc.yaml`, fill in
   `k8s/secret-example.yaml`'s real values and apply it as a real Secret
   (don't commit the filled-in version), then `kubectl apply -f k8s/deployment.yaml`.
3. Log in, open **Settings**, and fill in:
   - Proxmox host/node + a scoped API token (see `.env.example` for the
     `pveum` commands to create one rather than using root@pam) -- use
     **test connection** before saving to confirm it's reachable.
   - A disk storage (see "Disk storage + building templates from a qcow2"
     below).
   - Golden template VMIDs for whichever device kinds you'll use -- either
     build these by hand in Proxmox (install the OS/appliance once, then
     `qm template <vmid>`) same as before, or use the **templates** button
     to upload a qcow2 and have the app build+register one for you.

Env vars (`.env.example`) still work as an optional bootstrap default if
you'd rather pre-seed everything at deploy time instead of through the UI
(e.g. for a fully declarative office/OpenShift rollout) -- whatever's saved
via Settings simply takes precedence from then on.

## Portability notes (Docker / Podman / k3s / OpenShift)

The Dockerfile deliberately avoids assuming a fixed UID -- OpenShift's
default restricted SCC runs containers as an arbitrary, cluster-assigned
non-root UID (always in the root group, gid 0), which is stricter than
plain Docker/Podman/vanilla k3s. `chgrp -R 0` + `chmod -R g=u` on the
app and labs directories at build time is what actually makes that work,
not the `USER 1001` line itself (Docker/Podman/k3s honor it as-is; OpenShift
overrides it but keeps the group-writable permissions). Config is entirely
env-var driven for the same reason -- maps identically onto `docker run -e`,
`podman run -e`, and k8s/OpenShift Secrets.
