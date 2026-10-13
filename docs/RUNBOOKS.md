# Runbooks

Runbooks are reusable, versioned automation you run against a lab node:
log in on its serial console, answer first-boot prompts, read the IP it got
and save it on the node, set a static IP, install a license, reboot and wait
for it to come back — the same steps, every time, for anyone.

Open them from the **runbooks** button in the header. Three tabs:

- **Library** — every runbook and every version of it.
- **Runs** — recent runs; click one to watch it live or read its log.
- **Store** — the passwords and licenses runbooks use.

## What a runbook is

A YAML file with **inputs** (what the person running it fills in) and
**steps**. There is no scripting: a step is one of a few declarative kinds, so
a shared runbook can only do what these allow, against the node you choose.

| Step | Does |
| --- | --- |
| `console` | Types into the node's serial console and waits for output (`expect` / `send`), optionally capturing a value such as the IP. `paste` types a whole block of lines (a config), waits for the device to go quiet, and fails if it printed an error. |
| `http` | Calls the node's management API (iControl REST, PAN-OS XML API, FortiOS…), with polling to wait for a service or a reboot. |
| `lab` | Acts on labber-pve itself: `setMgmtIp` saves the IP on the node's card and lab file; `assertIdentity` checks the node's UUID/MAC. |
| `store` | Writes a captured value into the Store as a `text` entry, or with `type: secret` as a secret (e.g. an F5 master key; masked in logs). Never touches licenses, only replaces an existing entry when told to, and only replaces a secret in its own named group -- so it cannot overwrite your passwords. |
| `wait` | Pauses. |

The editor has a **syntax help** panel with every option. Values are
inserted with `{{inputs.x}}`, `{{store.name}}`, `{{steps.id.out.name}}`.
A filter can follow the name: `| b64`, `| url`, `| trim`, `| netmask`
(24 -> 255.255.255.0) and `| sha512crypt` (a salted `$6$` password hash,
for commands that take a hash instead of prompting for a password -- e.g.
Check Point's `set expert-password-hash`; a secret's hash is masked in logs
like the secret itself).

`console` steps need the node's template to have a serial console
(`serial0`); `http` steps need a management IP saved on the node.

## The Store

Named values that runbooks refer to **by name**, so a runbook never
contains a password or license and can be shared or exported safely.

- **secret** — a password or token (masked in lists; **edit** reveals it).
- **text** — any value, including multi-line.
- **license** — registration key, license text, add-on keys, and the
  **UUID and MAC it was issued for**. A runbook can check those against the
  node before installing, so the wrong license is never used up.

Edit anything at any time; the last 10 previous values are kept and can be
restored. Deleting warns if runbooks use the entry. Renaming breaks runbooks
using the old name.

Stored as plain JSON (`LABS_DIR/.config/store.json`, mode 0600) — the host
running labber-pve is assumed trusted. Encryption at rest is a possible
later step.

## Versions and locking

- A new runbook starts as a **draft** `1.0`: editable, runnable.
- **Lock** a version to publish it. Locking needs a description (and
  optionally what it was verified on, and a changelog). It is your call
  whether it has been tested enough — nothing forces a successful run first.
- A **locked** version cannot be edited or deleted in the app. To change it:
  **new version** (an editable draft of `1.1`, `1.2`…) or **copy as…** under
  a new name.
- Every locked version stays visible and runnable by everyone. Run defaults
  to the highest locked version; pick another from the dropdown.
- Drafts are visible to, and editable by, everyone.

Files live in `LABS_DIR/.runbooks/<name>/<version>.yml` plus a
`.meta.json`. To back up, copy that directory. An admin on the host can
delete a locked version by removing its two files; a locked file edited on
disk shows a *modified on disk* badge.

The runbooks shipped in `runbooks/builtin/` are copied there on first boot
(never overwriting what exists). The F5 and Palo Alto ones are **drafts,
unverified** until run on a real clone — refine, then lock.

## Console safety

A node's serial console is one shared channel. While a runbook is typing on
it, a person opening that console sees a banner naming the run and who
started it, with a **take over (aborts the run)** button for an expert who
must step in; the run is recorded as aborted by that person. Starting a run
while someone is already on the console asks first. The header also shows who
is currently logged in and which console they are on.

## Parked — circle back later

- Fuller console locking: queueing a run behind another, clearing stale
  locks after a crash, two runs on the same node.
- Encrypting the Store at rest.
- Triggering deploys and runbooks from outside (token-authenticated automation API, e.g. Jenkins).
- Auto-picking the next free license for a node.
- Palo Alto's cloud Licensing API (offline firewalls; needs a support-portal
  API key).
- Whether a second client can attach to a Proxmox serial console at all
  (assumed not) — to be tested on a real node.
- Verifying the vendor-specific commands in the built-in runbooks (F5 reboot
  and license calls, PAN-OS `request license` XML, first-boot prompts).

## The F5 runbooks

Shipped as drafts; lock each one once you have run it on your own template.
The usual order for a fresh BIG-IP:

1. `f5-first-boot` — serial console: waits for boot, answers the forced
   root password change, sets the admin password, saves the DHCP management
   IP on the node. (Run on BIG-IP 17.5.1.5.)
2. `f5-web-pass-change` — REST: waits for the management API, then has the
   admin change its own password (to the same value) so the web GUI stops
   demanding a change. A new F5 answers 401 to everything until then, which
   the runbook treats as "API is up". (Run on 17.5.1.5.)
3. `f5-skip-setup-utility` — REST: turns the web GUI's Setup Utility wizard
   off (`gui-setup disabled`) and saves. That flag lives in `sys global-settings`,
   which the config export leaves out, so a loaded config does not carry it —
   run this on every new node. **Not yet run on a real F5.**
4. `f5-install-license` — REST: checks the node's UUID/MAC against the
   license, installs it (offline from the saved text, or online from the
   registration key), optionally reboots. (Run on 17.5.1.5, offline.)
5. `f5-provision-modules` — REST: provisions LTM (default), ASM and
   iRules LX (ILX), all at nominal by default, waits for the F5 to finish
   restarting its services, and confirms each level. Plain iRules are part
   of LTM and need no provisioning; set ILX to skip if you don't use iRules
   LX. **Not yet run on a real F5.**
6. `f5-load-config` — REST: loads a configuration file saved as a Store
   `text` entry: checks it with the F5 first, then merges (or replaces) and
   saves. Run it last, after the license and provisioning. **Not yet run on a
   real F5.**

`f5-export-config` — the other direction: saves an F5's configuration as a
single configuration file, leaves out what must not be copied, and stores the
result as a `text` entry under a name you choose, ready for `f5-load-config`.
Pick what the config is for:

- **other-node** (default) — a config to load onto a different node. Leaves
  out the management IP/route, hostname (`sys global-settings`), device trust,
  local users, self IPs, provisioning, license, and certificate/key files.
- **same-node** — a config for a rebuilt copy of this node. Keeps hostname,
  local users, self IPs and provisioning; still leaves out the management
  IP/route, license, device trust and certificate/key files. Don't load it on
  a second node that runs at the same time (duplicate self IPs).

An SCF lists certificate and key files but does not contain them, and a target
F5 refuses a config that points at a file it lacks, so restoring device trust
or certificates needs a full backup archive (UCS), not this. "Also remove"
adds more prefixes to either profile. An existing entry is only replaced if
you say so, and the Store keeps its previous value in history. ASM policies,
SSL certificates/keys and the license are not part of the file. Store entries
can be up to 5 MB. **Not yet run on a real F5.**

If a stored config was exported with an older filter and F5's check fails with
`Syntax Error ... unexpected argument` on a line of random-looking characters,
stray certificate/key lines were left in it. Copy the entry's text, then
`pbpaste | python3 tools/scf-repair.py | pbcopy` and paste it back: it removes
only lines that sit outside every stanza and lists what it removed.

If F5's check says `Decryption of the field … failed while loading configuration
that is encrypted with a different master key`, the config holds values
(passwords, passphrases, some factory data) that only the device they came
from can decrypt. `f5-export-config` leaves those objects out by default and
lists them at the end of the stored text; for an entry exported earlier use
`pbpaste | python3 tools/scf-repair.py --all | pbcopy`. The same goes for objects
that point at a file in the original device's file store (a `cache-path` line:
certificates, keys, iFiles, F5's auto-update data): the export now leaves out
every such object by what it is, not by name. Objects that referred to one of
them are reported by F5's check; recreate them on the target.

`f5-set-static-ip` (console) is the alternative to step 1's DHCP address.

### Rebuilding an F5 HA pair (cluster)

Since `f5-export-config` 1.1 / `f5-load-config` 1.1 a cluster member's config
loads without hand-editing (no more `also_remove: sys folder|...`), and a pair
comes back as a pair:

1. On each member of the working cluster run `f5-export-config` **1.1** with
   profile **same-node**, "Leave out objects holding encrypted values" = **no**
   and "Also save the master key" = yes. Name them e.g. `f5-node1-config` and
   `f5-node2-config`; you get `f5-node1-config-master-key` too (cluster
   members share one master key, so either one serves both nodes). The
   export leaves out device trust (`cm`) and F5's `datasync-global` objects,
   strips device-group / custom traffic-group lines from `sys folder`
   stanzas, and writes the source's cluster settings as comments at the end.
2. In the lab file, per node: `f5-first-boot`, `f5-web-pass-change`,
   `f5-skip-setup-utility`, `f5-install-license`, **`f5-set-master-key`**
   (before provisioning -- once ASM is provisioned the node holds encrypted
   data and the key can no longer be changed safely), `f5-provision-modules`,
   `f5-load-config` **1.1** with the node's own entry.
3. Last on node 1: `f5-cluster-pair` with `waitFor: <node 2>` and
   `inputs: { peer: <node 2>, ha_ip: ..., peer_ha_ip: ..., device_group: ... }`.
   It renames each `cm device` to its hostname, resets and rebuilds device
   trust, sets the config-sync / failover / mirror addresses, creates the
   sync-failover group, syncs (also F5's own `datasync-global-dg`), waits for
   "In Sync", and checks one node is ACTIVE and the other STANDBY. F5 puts
   the root and `/Common` folders into the new group by itself.

See `labs/f5-ha-pair-restore-example.lab.yml`. Needs: different hostnames on
the two nodes (a same-node config carries each node's own), the HA self IPs
in the loaded configs, port lockdown on them allowing at least TCP 4353 and
UDP 1026, and the same admin password on both. Floating self IPs and virtual
addresses come back with the config; until the pair is built both nodes hold
them, so expect a short duplicate-address period during the build.

The master key: `f5-export-config` reads it with `f5mku -K`, and
`f5-set-master-key` installs it with `f5mku -r` (F5's "copy a master key to a
new system" method). F5 warns that changing the key on a device whose config
already holds encrypted values makes later loads fail, so the runbook looks
for `$M$` values first and refuses unless told otherwise. **Not yet run on a
real F5** (f5-set-master-key, f5-cluster-pair, export/load 1.1).

Steps can be made conditional with `when:` (add `not: true` to run a step
unless the value matches).

## Runbooks for the other vendors

All shipped as **drafts, not yet run on real nodes** except where noted. The
consoles' prompts follow each vendor's documentation, so expect to tighten a
few after the first real run, then lock them. First-boot runbooks come in
pairs: the plain one takes whatever address DHCP gives and saves it on the
node; the `-static` one sets the address you choose instead.

| Vendor | Runbooks | Password from the Store |
| --- | --- | --- |
| F5 BIG-IP | `f5-first-boot` (verified), `f5-first-boot-dhcp` (waits for the DHCP address; use for new labs), `f5-first-boot-static`, `f5-first-boot-finish` | `password-simple` |
| FortiGate | `fortigate-first-boot`, `fortigate-first-boot-static`, `fortigate-load-config` | `password-complex` |
| FortiManager | `fortimanager-first-boot-static` (no DHCP) | `password-complex` |
| Palo Alto PAN-OS | `paloalto-first-boot`, `paloalto-first-boot-static`, `paloalto-license-authcode`, `paloalto-load-config` | `password-simple` |
| Panorama | `panorama-first-boot-static` (no DHCP), also `paloalto-license-authcode` / `paloalto-load-config` | `password-simple` |
| Check Point Gaia | `checkpoint-set-mgmt-ip`, `checkpoint-set-interface`, `checkpoint-first-time-config` (role), `checkpoint-sms-add-gateway`, `checkpoint-sms-add-cluster` -- see below | `password-complex` |
| Nexus 9000v | `n9kv-first-boot`, `n9kv-first-boot-static` (skips POAP) | `password-complex` |
| Catalyst 8000V | `c8000v-first-boot`, `c8000v-first-boot-static` (skips the setup dialog + autoinstall) | `password-complex` |
| Cisco FTD | `ftd-first-boot`, `ftd-first-boot-static` | `password-complex` |
| Cisco FMC | `fmc-first-boot`, `fmc-first-boot-static` | `password-complex` |

Notes:

- The **load-config** runbooks for FortiGate and PAN-OS type the stored
  configuration into the serial console line by line (about 30 ms per line)
  and stop if the device prints an error. FortiGate takes its CLI text;
  PAN-OS takes `set` commands (capture with `set cli config-output-format
  set`, then `show` in configuration mode). Leave device-specific lines out.
- The **Catalyst 8000V** runbooks are for a node booted in autonomous IOS-XE
  mode. A template that boots in controller (SD-WAN) mode has no setup dialog;
  convert it with `controller-mode disable` first.
- **FTD / FMC** first boots can take 15-60 minutes before a login prompt
  appears; the runbooks wait up to 45-60 minutes. Their EULA and password
  prompts vary between builds, so those steps are written to cope with either
  order.
- Console actions with `optional: true` skip their whole action, including
  the `send`, when the prompt never appears.

## Bootstrapping a whole lab

A lab file can list runbooks for each node; labber-pve runs them right after
the VMs are built and started, so deploying a lab can also license it and
bring it up. See `labs/f5-bootstrap-example.lab.yml`.

```yaml
nodes:
  f5-1:
    kind: f5_bigip_ve
    bootstrap:
      - runbook: f5-first-boot
      - runbook: f5-install-license
        inputs: { license: lic-lab-01, method: offline }
        wait: 20          # optional: pause this many seconds first
        onFail: stop      # stop (default) | continue
      - runbook: f5-cluster-pair
        waitFor: f5-2     # optional: first wait until f5-2's whole bootstrap has finished
        inputs: { peer: f5-2, ha_ip: 10.1.30.11, peer_ha_ip: 10.1.30.12 }
```

- The node is the runbook's target automatically; `inputs` supplies the rest
  (Store entry names, choices). `version:` pins a version, otherwise the
  highest locked one runs.
- Each node's list runs in order; different nodes run in parallel (up to 3).
- `waitFor: <node>` (or a list) holds an entry until those nodes have finished
  their whole bootstrap; if one of them fails, the waiting entry fails too
  and resumes with the rest after a fix. A loop (A waits for B, B for A) is
  refused when the lab file is checked. Nodes that others wait for are
  started first.
- A runbook with a second node input (`f5-cluster-pair`'s `peer`) takes that
  node's name: `inputs: { peer: f5-2 }`.
- Before anything is built, every named runbook and Store entry is checked,
  so a typo fails in seconds, not after a ten-minute build.
- Progress prints in the lab's deploy terminal, e.g. `[f5-1] f5-first-boot:
  Read the management IP ✓`; each run also appears in the Runs tab.
- `wait:` is rarely needed — runbook steps already wait for what they depend
  on (`expect` for the console, `poll` for APIs). Use it only where there is
  no condition to wait for.

### If something fails

| Where | Default | Setting |
| --- | --- | --- |
| Building the lab fails | **Roll back** — remove what that deploy created (nothing is licensed or configured yet) | `onDeployFailure: keep` leaves it up for debugging |
| A bootstrap runbook fails | **Keep the lab**, mark it failed (amber dot), name the node and runbook | `onBootstrapFailure: destroy` tears it down (throwaway labs) |

After a bootstrap failure, fix the cause (a Store entry, the runbook, the
node) and press **bootstrap** in the Labs window: it resumes each node from
the runbook that failed and does not repeat finished ones — important because
runbooks like `f5-first-boot` cannot run twice on the same node.

Progress is kept as *how many entries of the node's `bootstrap:` list are
done*, not by name. So you can swap the failed entry for a different runbook
(or a fixed copy under a new name) at the same position and resume; do not
insert or remove entries before it. A failed runbook restarts from its first
step, which matters when the failure came late: `f5-first-boot` cannot be run
again after its password change (the factory login no longer works). For that
case swap in `f5-first-boot-finish`, which does only the remaining steps (read
the management IP, save, store it on the node) on the console that is still
logged in.

### Lab variables

Put per-copy values in a `vars:` block and use `{{vars.name}}` anywhere in the
file (bridges, license names, node settings). To build a replica on other
links or with other licenses, copy the lab file and edit only `vars:`. A value
that is just a placeholder keeps its type (`cores: "{{vars.cores}}"` is a
number). Saving a node's management IP or UUID/MAC pins back into the file
keeps your placeholders intact.

### Check Point: one template, every role

Gaia's role (Security Gateway, cluster member, standalone gateway + management,
Security Management Server) is chosen in its First Time Configuration Wizard,
not by the installer, so one template serves them all:

1. **Template.** Build it from the Gaia ISO (templates window), complete the
   installer over the console -- it asks for a management IP; any address will
   do -- and shut the VM down **before** the First Time Configuration Wizard.
   Then **finalize**. New Gaia templates get a serial console; for an existing
   one use Settings -> Templates -> edit hw -> serial0.
2. **Per node**, in the lab file's `bootstrap:` list:

| Runbook | What it does |
| --- | --- |
| `checkpoint-set-mgmt-ip` | Moves the clone off the shared install-time IP: checks the node has `original_ip`, sets the new IP and default route, saves. Re-running is safe. |
| `checkpoint-set-interface` | Gives another interface an address and brings it up -- a cluster member's sync interface, a data interface. |
| `checkpoint-first-time-config` | `role`: `gateway` (managed by an SMS), `cluster-member`, `standalone` (gateway + management on one box) or `sms`. Writes a `config_system` file, validates it with `--dry-run`, applies it, reboots. |
| `checkpoint-sms-add-gateway` | On the SMS: waits for the API and for the gateway's SIC port, adds the gateway object (establishing SIC), optionally installs a policy. |
| `checkpoint-sms-add-cluster` | On the SMS: the same for a two-member ClusterXL HA cluster (virtual IP + sync interface). |

**[CHECKPOINT.md](CHECKPOINT.md) is the full walkthrough with five sample labs.**
`labs/checkpoint-cluster-example.lab.yml` puts it together: an SMS, a two-member
cluster and one more gateway. Put the install-time IP in the lab's `vars:` and
pass it as `original_ip` to every node. List gateways and members **before**
the SMS -- bootstrap runs nodes in file order, three at a time, and the SMS
runbooks wait for the gateways to finish.

Store entries: `password-complex` (Gaia admin and expert passwords),
`checkpoint-sic` (SIC one-time key) and `checkpoint-admin` (SmartConsole
administrator password) -- the last two letters and digits only, as Check
Point requires. The SMS runbooks use `mgmt_cli -r true` on the SMS itself over
the serial console, so the management API never has to accept remote calls.

All five are drafts. Parameters follow Check Point's documentation
(`config_system`, Gaia clish, the management API's `add simple-gateway` /
`add simple-cluster`), and `config_system --dry-run` stops a bad
configuration before anything is applied -- but each still needs one run on
your Gaia version before locking.
