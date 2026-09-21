# Advanced features

## Web rp setup

Once a node has a management IP, its dashboard card shows two ways to
reach its web UI. **web ui** opens `https://<ip>:<port>/` directly in a
new tab — no further setup. **web rp** ("web reverse proxy") embeds the
same UI in an in-dashboard `<iframe>`, only shown once a **GUI domain**
is configured (Settings → "Embedded GUI proxy"). This needs a bit more
setup, since embedding requires stripping `X-Frame-Options`/CSP headers
most vendor UIs send, and a raw-IP iframe can't get past a
self-signed-cert warning the way a new-tab navigation can:

1. A wildcard DNS record: `*.<GUI domain>` (e.g.
   `*.gui.labber.example.com`) → wherever your reverse proxy/Ingress
   lives.
2. A reverse-proxy/Ingress rule forwarding that same wildcard host to
   this app's `lib/gui-proxy.js` listener — a second HTTP server,
   separate from the main app port (`GUI_PROXY_PORT` env var, default
   `8081`). It Host-header-routes `<labName>--<nodeName>.<GUI domain>`
   to that node's live mgmt IP (resolved from deployed lab state on
   every request, not cached), strips the framing-blocking headers on
   the way back, and 404s for anything it doesn't recognize.
3. Attach/request a TLS cert covering `*.<GUI domain>` wherever that
   reverse proxy terminates TLS (the proxy itself speaks plain HTTP —
   whatever fronts it is assumed to be the real TLS termination point).
4. Set the **GUI domain** field in Settings to that same value.

Some vendor web UIs ship their own anti-clickjacking/frame-busting
inline scripts that assume they're never embedded — `lib/gui-proxy.js`
carries a small, narrowly-targeted set of string-replace patches for
the specific vendors this project has actually hit that on (documented
inline in the file itself). If a new vendor's UI shows a blank iframe,
check its own page source for a similar `top.location`/`self != top`
pattern before assuming it's a bug here.

## Remote stats API (optional, for external dashboards)

Settings has a toggle for a read-only, **unauthenticated**
`GET /api/public/stats` endpoint, plus an optional comma-separated IP
allowlist. Off by default — with the toggle off the endpoint 404s, same
as if the route didn't exist. This is what lets an external site (e.g.
a homepage's lab-status widget) show lab stats without needing a login
of its own; logged-in users always see the identical data at
`GET /api/stats` regardless of the toggle — it also backs the
dashboard's own stats-bar CPU/mem/disk tiles.

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
currently `running`. `host.*` comes from the **Proxmox node's own API**
(`GET /nodes/{node}/status`), polled every 10s and cached. `host.disk`
is specifically the **configured disk storage's** usage, not the
node's root filesystem, so it reflects what lab clones/templates
actually consume; falls back to rootfs if no disk storage is
configured yet.

Settings are stored in `LABS_DIR/.config/api-settings.json`.

## API relay (automation gateway, optional)

Settings → Public API also has an **API relay** toggle: this lets your
own automation (curl, Ansible, a CI pipeline) reach a lab node's *real*
management API through this app, without needing a VPN/route into the
lab's own management network from wherever that automation runs.

```
curl -H "X-Labber-Relay-Token: lbr_...token..." \
  -H "Authorization: Bearer <fgt1's own API token>" \
  https://labber.example.com/api/relay/the-big-lab/fgt1/api/v2/cmdb/system/status
```

is forwarded, byte-for-byte (including that `Authorization` header,
meant for `fgt1` itself, not this app), to:

```
https://<fgt1's mgmt IP>:<fgt1's mgmt port>/api/v2/cmdb/system/status
```

Node lookup uses the exact same deployed-lab-state resolution as the
dashboard's own "web ui"/"web rp" buttons — a node needs a mgmt IP
saved on its dashboard card before its relay path resolves to
anything.

**Deliberately just a relay, not a full gateway with stored device
credentials.** This app does not know or store each device's own admin
username/password — your request needs to carry whatever auth the
device itself expects, exactly as if you were calling it directly.
That's also why the relay's own token rides in a dedicated
`X-Labber-Relay-Token` header rather than `Authorization`: many vendor
REST APIs (BIG-IP iControl, PAN-OS, FortiOS) expect `Authorization` for
their own credential.

This is a different code path from **web rp** deliberately: gui-proxy
exists to make a vendor's UI survive being embedded in a browser
iframe — none of that is meaningful, and some of it would be actively
wrong, for a scripted API client. The relay does zero header/body
rewriting; what you send is exactly what the device receives.

Setup:

1. Settings → Public API → check **enable API relay**, save.
2. Same panel, **create a token** — give it a label, and optionally a
   **lab scope** (restricts that token to one lab's nodes only). The
   raw token is shown exactly once at creation time — copy it
   immediately, it can't be recovered later, only revoked and
   reissued.
3. Send it as `X-Labber-Relay-Token: <token>` on every relay request.

Tokens are stored in `LABS_DIR/.config/api-tokens.json` (bcrypt-hashed).

**Not yet covered**: devices that are CLI/SSH-managed rather than
REST-API-managed (e.g. Cisco NX-OSv has no primary HTTPS API) can't be
reached through this relay — it's HTTP(S)-only.

## Disk storage + building templates from a qcow2

Golden templates don't have to be hand-built by installing an
OS/appliance once and running `qm template`. The **templates** button
in the header uploads a qcow2 (or raw/vmdk) straight from the browser
and turns it into a Proxmox template, entirely through the PVE API.

How it works (`lib/template-builder.js`):

1. The file is staged on the configured disk storage's `import`
   content type (`POST /nodes/{node}/storage/{storage}/upload`,
   `content=import`).
2. A bare VM is created with that device kind's hardware profile
   (bios, machine type, CPU, cores/memory, disk bus, scsi controller,
   NIC count) — see `vendor-profiles.js`'s `hw` blocks.
3. The staged image is attached as that VM's disk via
   `import-from=<storage>:import/<file>` — Proxmox itself does the
   qcow2 → target-format conversion during this step.
4. The VM is converted to a template and its vmid is saved as that
   kind's template on the Settings page.

Two hardware-profile fields worth knowing about beyond the obvious
ones: `nicModel` (default `virtio`) — some appliances need `e1000`
specifically; and `scsihw` being optional — a SATA disk bus needs no
SCSI controller type at all.

### Building from an install ISO instead of a qcow2

Not every appliance ships a ready-to-boot qcow2 — some vendors are
built from an install ISO instead (`installFromIso: true` on their
profile). The **templates** modal accepts `.iso` alongside
qcow2/img/raw/vmdk; for an ISO-flagged kind, an extra "disk size (GB)"
field appears. The build creates a blank disk of that size, attaches
the ISO as a CD-ROM, sets boot order to disk-then-CD-ROM, and starts
the VM — then stops at an **awaiting-install** status instead of
auto-templating, since finishing an interactive installer over console
is a real manual step no upload alone can skip. Once you've completed
the installer and shut the VM down, click **finalize as template** in
the same modal to convert it.

### Disk storage setup (one-time, in Proxmox)

Pick where template + lab disks should live via the Settings page's
**Disk storage** section:

- **Use an existing storage as-is** — just pick it from the dropdown.
- **Carve a new directory storage out of an existing mount** — pick a
  parent storage, type a name, and **create storage**. This calls
  Proxmox's own storage API (`POST /storage`, `type=dir`,
  `create-base-path=1`), which creates the subdirectory and registers
  the new storage for you.

One real constraint: the `import` content type used for staging
uploaded images only works on **directory-backed** storage
(dir/NFS/CIFS), not LVM-thin/ZFS block storage.
