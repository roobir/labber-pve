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
  lab-bridge.js         -- websocket: streams deploy/destroy progress to the dashboard
  gui-proxy.js           -- second HTTP listener: Host-header-routed reverse proxy
                            for embedding a node's own web UI in-dashboard ("web rp")
  api-relay.js           -- path-routed reverse proxy on the main app port for
                            automation/API clients (see docs/ADVANCED.md)
  api-tokens.js          -- bearer tokens gating api-relay.js
  auth.js               -- session-based multi-user auth
public/                 -- dashboard frontend
labs/                   -- your *.lab.yml topology files live here (bind-mounted/PVC'd in)
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
