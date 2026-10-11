# Check Point labs, end to end

One Gaia template, cloned as many times as you like, each clone turned into
whatever it should be -- standalone, gateway, cluster member, or Security
Management Server -- by runbooks in the lab file. This page walks through it
and gives five ready-to-copy labs.

> All five Check Point runbooks are **drafts**: their commands follow Check
> Point's documentation, and `config_system --dry-run` stops a bad
> configuration before anything changes, but run each once on your Gaia
> version (watch the live console in the Runs tab) before locking it.

## How it fits together

```
 Gaia ISO --(templates window, install once, shut down before the
             First Time Configuration Wizard, finalize)--> Gaia template
                                                                |
                                       deploy: every node is a clone of it,
                                       all with the SAME install-time IP
                                                                |
 per node, in its bootstrap list (over the serial console):     v
   1. checkpoint-set-mgmt-ip         original IP -> this node's own IP
   2. checkpoint-set-interface       (cluster members) sync interface IP
   3. checkpoint-first-time-config   role: standalone | gateway |
                                           cluster-member | sms
 on the SMS, after its own step 3:
   4. checkpoint-sms-add-gateway     gateway object + SIC (+ policy)
      checkpoint-sms-add-cluster     cluster object + SIC (+ policy)
```

## Before the first lab

1. **Template.** Templates window -> kind *Check Point Gaia* -> upload the Gaia
   ISO. When the job says *awaiting install*, open the node's console and run
   the installer. It asks for a management IP: pick one address for all labs
   -- that is the **install-time IP** every clone will boot with. When Gaia
   is installed and has rebooted to its login prompt, **shut it down without
   running the First Time Configuration Wizard**, then click **finalize**.
   (New Gaia templates have a serial console. For an older one: Settings ->
   Templates -> Check Point Gaia -> edit hw -> serial0.)
2. **Store** (Runbooks window -> Store), all *secret*:

   | Entry | Used for | Rules |
   | --- | --- | --- |
   | `password-complex` | Gaia `admin` password (as typed in the installer) and the expert password | Gaia's own |
   | `checkpoint-sic` | SIC one-time key shared by gateways, cluster members and the SMS | letters and digits, 4-127 |
   | `checkpoint-admin` | SmartConsole administrator password (standalone / SMS) | letters and digits |

3. **IP plan.** Decide each node's management IP (and sync IPs for a cluster).
   The samples use `192.168.99.0/24` on the external bridge `vmbr0` -- change
   them to your network.

## Sample 1 -- standalone (gateway + management on one box)

`labs/checkpoint-standalone-example.lab.yml`. The smallest working lab: log in
with SmartConsole at `192.168.99.80` as `admin` / `checkpoint-admin`.

```yaml
vars:
  cp_install_ip: 192.168.1.1   # the IP typed during the one-time Gaia install
  mgmt_gw: 192.168.99.1

nodes:
  cp-standalone:
    kind: checkpoint_gaia
    bootstrap:
      - runbook: checkpoint-set-mgmt-ip
        inputs: { original_ip: "{{vars.cp_install_ip}}", ip: 192.168.99.80, gateway: "{{vars.mgmt_gw}}" }
      - runbook: checkpoint-first-time-config
        inputs: { role: standalone, hostname: cp-standalone }

links:
  - name: mgmt
    external: true
    bridge: vmbr0
    endpoints:
      - { node: cp-standalone, interface: net0 }
```

## Sample 1b -- Security Management Server only (no gateway)

`labs/checkpoint-sms-only-example.lab.yml`. Management without any gateway --
for SmartConsole, policy and management API work, or to add gateways to later
(run `checkpoint-sms-add-gateway` on it when one exists). Note Check Point's
naming: *standalone* means gateway **and** management on one box (sample 1);
a management-only box is simply an SMS.

```yaml
vars:
  cp_install_ip: 192.168.1.1   # the IP typed during the one-time Gaia install
  mgmt_gw: 192.168.99.1

nodes:
  cp-sms:
    kind: checkpoint_gaia
    bootstrap:
      - runbook: checkpoint-set-mgmt-ip
        inputs: { original_ip: "{{vars.cp_install_ip}}", ip: 192.168.99.60, gateway: "{{vars.mgmt_gw}}" }
      - runbook: checkpoint-first-time-config
        inputs: { role: sms, hostname: cp-sms }

links:
  - name: mgmt
    external: true
    bridge: vmbr0
    endpoints:
      - { node: cp-sms, interface: net0 }
```

## Sample 1c -- Security Gateway only (no SMS in the lab)

`labs/checkpoint-gateway-only-example.lab.yml`. A gateway that finishes its
first-time configuration and waits to be managed: connect it to a Security
Management Server outside the lab (another lab, Smart-1 Cloud) by adding it
there with the `checkpoint-sic` key, or run `checkpoint-sms-add-gateway` on an
SMS you deploy later. Until a management server installs a policy, Check Point
runs it with its *InitialPolicy*, which blocks traffic through the gateway apart
from management access to it.

```yaml
vars:
  cp_install_ip: 192.168.1.1   # the IP typed during the one-time Gaia install
  mgmt_gw: 192.168.99.1

nodes:
  cp-gw1:
    kind: checkpoint_gaia
    bootstrap:
      - runbook: checkpoint-set-mgmt-ip
        inputs: { original_ip: "{{vars.cp_install_ip}}", ip: 192.168.99.61, gateway: "{{vars.mgmt_gw}}" }
      - runbook: checkpoint-first-time-config
        inputs: { role: gateway, hostname: cp-gw1 }

links:
  - name: mgmt
    external: true
    bridge: vmbr0
    endpoints:
      - { node: cp-gw1, interface: net0 }
```

## Sample 2 -- Security Management Server + one gateway

`labs/checkpoint-sms-gateway-example.lab.yml`. The SMS adds the gateway,
establishes SIC and installs the *Standard* policy on it.

```yaml
vars:
  cp_install_ip: 192.168.1.1
  mgmt_gw: 192.168.99.1

nodes:
  cp-gw1:                      # gateways first: the SMS waits for them
    kind: checkpoint_gaia
    bootstrap:
      - runbook: checkpoint-set-mgmt-ip
        inputs: { original_ip: "{{vars.cp_install_ip}}", ip: 192.168.99.61, gateway: "{{vars.mgmt_gw}}" }
      - runbook: checkpoint-first-time-config
        inputs: { role: gateway, hostname: cp-gw1 }
  cp-sms:
    kind: checkpoint_gaia
    bootstrap:
      - runbook: checkpoint-set-mgmt-ip
        inputs: { original_ip: "{{vars.cp_install_ip}}", ip: 192.168.99.60, gateway: "{{vars.mgmt_gw}}" }
      - runbook: checkpoint-first-time-config
        inputs: { role: sms, hostname: cp-sms }
      - runbook: checkpoint-sms-add-gateway
        inputs: { gateway_name: cp-gw1, gateway_ip: 192.168.99.61, install_policy: "yes" }

links:
  - name: mgmt
    external: true
    bridge: vmbr0
    endpoints:
      - { node: cp-sms, interface: net0 }
      - { node: cp-gw1, interface: net0 }
```

## Sample 3 -- SMS + two-member ClusterXL HA cluster + one more gateway

`labs/checkpoint-cluster-example.lab.yml`.

| Node | Mgmt IP (eth0) | Sync IP (eth1) | Role |
| --- | --- | --- | --- |
| cp-gw1 | 192.168.99.71 | 10.255.0.1 | cluster member |
| cp-gw2 | 192.168.99.72 | 10.255.0.2 | cluster member |
| (cluster VIP) | 192.168.99.70 | -- | `cp-cluster` |
| cp-gw3 | 192.168.99.73 | -- | gateway |
| cp-sms | 192.168.99.60 | -- | Security Management Server |

```yaml
vars:
  cp_install_ip: 192.168.1.1
  mgmt_gw: 192.168.99.1

nodes:
  cp-gw1:
    kind: checkpoint_gaia
    bootstrap:
      - runbook: checkpoint-set-mgmt-ip
        inputs: { original_ip: "{{vars.cp_install_ip}}", ip: 192.168.99.71, gateway: "{{vars.mgmt_gw}}" }
      - runbook: checkpoint-set-interface
        inputs: { interface: eth1, ip: 10.255.0.1 }
      - runbook: checkpoint-first-time-config
        inputs: { role: cluster-member, hostname: cp-gw1 }
  cp-gw2:
    kind: checkpoint_gaia
    bootstrap:
      - runbook: checkpoint-set-mgmt-ip
        inputs: { original_ip: "{{vars.cp_install_ip}}", ip: 192.168.99.72, gateway: "{{vars.mgmt_gw}}" }
      - runbook: checkpoint-set-interface
        inputs: { interface: eth1, ip: 10.255.0.2 }
      - runbook: checkpoint-first-time-config
        inputs: { role: cluster-member, hostname: cp-gw2 }
  cp-gw3:
    kind: checkpoint_gaia
    bootstrap:
      - runbook: checkpoint-set-mgmt-ip
        inputs: { original_ip: "{{vars.cp_install_ip}}", ip: 192.168.99.73, gateway: "{{vars.mgmt_gw}}" }
      - runbook: checkpoint-first-time-config
        inputs: { role: gateway, hostname: cp-gw3 }
  cp-sms:
    kind: checkpoint_gaia
    bootstrap:
      - runbook: checkpoint-set-mgmt-ip
        inputs: { original_ip: "{{vars.cp_install_ip}}", ip: 192.168.99.60, gateway: "{{vars.mgmt_gw}}" }
      - runbook: checkpoint-first-time-config
        inputs: { role: sms, hostname: cp-sms }
      - runbook: checkpoint-sms-add-cluster
        inputs:
          cluster_name: cp-cluster
          cluster_ip: 192.168.99.70
          member1_name: cp-gw1
          member1_ip: 192.168.99.71
          member1_sync_ip: 10.255.0.1
          member2_name: cp-gw2
          member2_ip: 192.168.99.72
          member2_sync_ip: 10.255.0.2
      - runbook: checkpoint-sms-add-gateway
        inputs: { gateway_name: cp-gw3, gateway_ip: 192.168.99.73 }

links:
  - name: mgmt
    external: true
    bridge: vmbr0
    endpoints:
      - { node: cp-sms, interface: net0 }
      - { node: cp-gw1, interface: net0 }
      - { node: cp-gw2, interface: net0 }
      - { node: cp-gw3, interface: net0 }
  - name: sync
    endpoints:
      - { node: cp-gw1, interface: net1 }
      - { node: cp-gw2, interface: net1 }
```

## Things worth knowing

- **Order.** Bootstrap runs nodes in the order they appear in the file, three
  at a time, each node's list in order. Put gateways and cluster members
  **before** the SMS: the SMS runbooks wait (up to an hour per gateway) until
  each gateway answers on its SIC port, so they must already be running.
- **Shared install IP.** All clones boot with `cp_install_ip`. That clash only
  lasts until each node's first runbook, and those changes happen over the
  serial console, not the network. `checkpoint-set-mgmt-ip` refuses to touch a
  node that doesn't have the original IP, and is a no-op on a node that already
  has its new one -- so a resumed bootstrap is safe.
- **Interfaces.** Proxmox `net0`, `net1`, ... appear in Gaia as `eth0`, `eth1`,
  ... A data network between gateways or to a test host is just another link
  (two or more endpoints), plus `checkpoint-set-interface` on each gateway.
- **Timing.** First-time configuration of an SMS or standalone takes 15+
  minutes; the SMS runbooks also wait for its management API (`api status`).
- **Version.** `checkpoint-sms-add-gateway` / `-cluster` default to `R81.20`;
  set `version:` to match your gateways.
- **Policy.** `install_policy: "yes"` installs the *Standard* package (or
  `policy_package:`). Off by default, because a fresh gateway's topology may
  need adjusting in SmartConsole first.
- **If a step fails,** the run stops with the reason (for example "the node has
  10.0.0.9 ... wrong node or wrong original_ip?", or `config_system`'s own
  `--dry-run` message), and the lab stays up. Fix it and press **bootstrap**
  to resume from that runbook (see [RUNBOOKS.md](RUNBOOKS.md)).

## The runbooks

| Runbook | Runs on | Key inputs |
| --- | --- | --- |
| `checkpoint-set-mgmt-ip` | every node | `original_ip`, `ip`, `prefix`, `gateway`, `interface` (eth0) |
| `checkpoint-set-interface` | cluster members (sync), any data interface | `interface`, `ip`, `prefix` |
| `checkpoint-first-time-config` | every node | `role`, `hostname`; optional `ip` (empty = keep the current one) |
| `checkpoint-sms-add-gateway` | the SMS | `gateway_name`, `gateway_ip`, `version`, `install_policy` |
| `checkpoint-sms-add-cluster` | the SMS | `cluster_name`, `cluster_ip`, member names / IPs / sync IPs, `version`, `install_policy` |

References: Check Point's *Running the First Time Configuration Wizard in CLI
Expert mode* (`config_system`), the Gaia administration guide (interfaces,
static routes), and the ClusterXL guide's *Cluster Management APIs*
(`add simple-cluster`).
