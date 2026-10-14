# Architecture

```
lib/
  config-store.js      -- persisted Proxmox connection + template settings (Settings page)
  proxmox-client.js    -- thin HTTP wrapper over the PVE REST API + async task polling
  network-manager.js   -- per-link vmbr bridge naming/provisioning (15-char IFNAMSIZ safe)
  vendor-profiles.js   -- device kind -> golden template VMID + VM hardware profile
  template-builder.js  -- uploaded qcow2 -> golden template, via PVE's import-from
  lab-manager.js       -- YAML-driven deploy/destroy orchestration + state tracking
  console-bridge.js    -- websocket proxy: browser <-> PVE termproxy/vncwebsocket
  console-session.js   -- the PVE termproxy protocol itself, shared by the browser
                            console and runbook console steps
  console-locks.js     -- who is on which node's console (runbook vs people, takeover)
  presence.js          -- who is logged in right now (header indicator)
  runbooks/            -- runbook engine, library (versions/locking), Store, run manager
                            (see docs/RUNBOOKS.md)
  runbook-bridge.js    -- websocket: streams a run's steps/log/console to the browser
  lab-bridge.js         -- websocket: streams deploy/destroy progress to the dashboard
  gui-proxy.js           -- second HTTP listener: Host-header-routed reverse proxy
                            for embedding a node's own web UI in-dashboard ("web rp")
  api-relay.js           -- path-routed reverse proxy on the main app port for
                            automation/API clients (see docs/ADVANCED.md)
  api-tokens.js          -- bearer tokens gating api-relay.js
  auth.js               -- session-based multi-user auth
  client-ip.js          -- the request's source address (login throttling, IP allow-list, audit)
  audit/                -- activity log: log.js (append-only JSONL per day + query),
                            actions.js (REST call -> named action, allow-listed fields),
                            middleware.js (records every /api/* change), summary.js
                            (changes per user for the "most active" chart)
  backup/               -- Settings -> Backup: collect.js (allow-listed files, no secrets),
                            push.js (one commit per backup) via push-github.js (git-data API)
                            or push-forgejo.js (change-files API), git-api.js (REST client +
                            server detection), schedule.js, health.js, run.js, settings.js
                            (see docs/BACKUP.md)
  lab-transfer.js       -- lab export (exact / clean copy) and import as a new lab
  lab-import-check.js   -- what an imported lab needs that this labber lacks
runbooks/builtin/       -- runbooks shipped in the image, seeded into app storage on boot
public/                 -- dashboard frontend
labs/                   -- your *.lab.yml topology files live here (bind-mounted/PVC'd in)
test/                   -- unit tests, `npm test` (node:test, no extra dependencies)
k8s/                    -- Deployment/Service/PVC/Secret-template for k3s or OpenShift
```

## Known limitations

A few things are worth empirical verification against your own Proxmox
version before relying on them, rather than assuming guaranteed-correct:

- **`network-manager.js`'s `applyNetworkChanges()`** — the exact call
  to apply pending bridge changes on a node is grounded in community
  references, not independently confirmed against the official PVE API
  schema.
- **`console-bridge.js`'s termproxy/vncwebsocket handshake** — API
  tokens are **not** accepted for this one endpoint category (a known
  Proxmox limitation), even though the token works everywhere else in
  this app. Console access needs a real Proxmox username+password
  configured in Settings ("Console access" section) alongside the API
  token, used only to obtain a session ticket for termproxy/
  vncwebsocket.
- **`template-builder.js`'s upload + import-disk flow** — grounded in
  Proxmox's own Import Wizard/storage-import API (PVE 8.1+), but worth
  confirming on first use whether your PVE version's "Import" content
  type needs to be enabled on the storage explicitly (Datacenter →
  Storage → *storage* → edit → Content) even though this app requests
  it as part of storage creation.

Everything else (clone, VM config/networking, start/stop/delete, task
polling, auth, the console/lab websocket bridges) is grounded in
Proxmox's documented API shape and has been run against a real node.

## Keeping the web UI cheap

The dashboard polls, so the cost of one poll is what matters:

- **One Proxmox call per poll, shared.** `/api/status` and `/api/stats` both
  need every node's power state. `lab-status.getAllStatuses()` asks Proxmox for
  the whole VM list once (`GET /nodes/{node}/qemu`) and shares that answer for
  2 s between both endpoints and every open tab; starting/stopping a node or
  finishing a deploy clears it. (Before: one call per node per lab, twice per
  cycle.) `getLabStatus()` for a single lab stays exact and live -- the console
  uses it.
- **Proxmox connections are reused.** `proxmox-request.js` keeps one keep-alive
  connection pool per set of Proxmox settings instead of a new TLS handshake
  per call.
- **Hidden tabs do not poll**; they refresh the moment the tab is shown.
- **Run history is indexed.** The Runs tab re-reads only run files that changed.
- **Responses are gzip-compressed** (HTML/JS/CSS/JSON).
- **Live logs build their terminal lazily**, only when there is output to show.

## Node version and TLS to appliances

The image runs Node 24 (`node:24-alpine`); the code is also tested on Node 20
(`engines: >=20`). Two things differ on 24:

- **Appliance TLS.** Node 24's OpenSSL refuses a server that offers only
  1024-bit Diffie-Hellman parameters, which some older appliance images do.
  Node 20 accepted them. `lib/appliance-tls.js` keeps that tolerance (OpenSSL
  security level 1) for the connections that already skip certificate checks:
  the web rp proxy, the API relay and REST runbook steps. Proxmox connections
  keep the strict default. Weak RSA keys, SHA-1 certificates and TLS 1.2
  appliances work on both; TLS 1.0/1.1-only appliances fail on both.
- **One deprecation warning.** `http-proxy` (web rp) calls `util._extend`, which
  Node 24 warns about. The image sets `NODE_OPTIONS=--disable-warning=DEP0060`
  to silence just that one. `http-proxy` is unmaintained; replacing it (for
  example with its maintained fork `http-proxy-3`) is the longer-term fix.

### Measured on Node 20 vs 24

Same server, a lab directory of 20 labs (60 nodes), a fake Proxmox, 20
concurrent clients: the status/stats endpoints ran about 15-18% faster on
Node 24 (roughly 3,000 vs 2,600 req/s, p99 8 ms vs 10 ms) and a gzip'd static
file about twice as fast; start-up time is the same (~150 ms). Under that
synthetic load (far above real use) Node 24 holds its memory at a ~230 MB
plateau where Node 20 gives it back (~95 MB after the load); at idle Node 24
is lower (~80 MB vs ~98 MB). A real dashboard polls a few times a second.

## Where the code lives (large features)

Files are kept small by splitting along the feature's own seams:

- **Deploy / destroy / update** -- `lib/lab-deploy.js` is a thin facade (per-lab
  queue + exports) over `lib/deploy/`: `vmid.js` (id allocation), `node-ops.js`
  (clone / remove one VM, shared by deploy, update and destroy), `bridges.js`,
  `wiring.js` (the NIC plan deploy applies and update diffs), `reconcile-node.js`
  (update's live-config diff), and `deploy.js` / `destroy.js` / `update.js`.
- **Lab state** -- `lib/lab-state.js` re-exports `lab-status.js` (dashboard
  status, one shared Proxmox call) and `lab-nodes.js` (one node's IP, identity
  pin, GUI-proxy target).
- **Dashboard cards** -- `public/js/dashboard-cards.js` assembles a card from
  `card-menu.js` (dropdowns, power), `card-ip.js` (mgmt IP) and
  `card-identity.js` (UUID/MAC), with shared helpers in `card-util.js`.
- **New-lab wizard** -- `public/js/labs-wizard.js` opens/submits a form built by
  `wizard-view.js` (shared elements + NIC summary), `wizard-nodes.js`,
  `wizard-links.js`, `wizard-bridges.js` and `wizard-payload.js`.
