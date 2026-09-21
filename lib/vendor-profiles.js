const configStore = require('./config-store');

// Static per-kind metadata. templateId is *not* stored here -- it comes
// from config-store (Settings page or its env-var bootstrap defaults) so it
// can be changed at runtime without a redeploy.
//
// The `hw` block is the VM hardware profile used by template-builder.js when
// building a golden template from an uploaded qcow2 -- it's what would
// otherwise be hand-picked in the Proxmox UI (bios/machine/scsihw/disk bus/
// nic count/nic model). These are sourced directly from known-working
// hand-built VMs, not guessed, wherever a real reference exists:
//   - paloalto_*: virtio0 disk bus, q35 + seabios, serial0 socket console
//     (qemu-server *.conf dumps from this homelab's own Proxmox node)
//   - checkpoint_gaia: scsi0/lsi, default (i440fx) machine, no serial
//     console (same source) -- also the one kind built from an .iso
//     installer rather than a ready-to-boot qcow2, see installFromIso below
//   - fortios/fortimanager: scsi0/virtio-scsi-single -- the original
//     hand-built reference configs had no serial0 line, but empirically
//     confirmed (added serial0:socket to a live clone of each and it
//     worked, console responded to input) that both images do support a
//     serial console, just weren't configured for one -- so unlike the
//     reference configs, these now request one by default.
//   - cisco_n9kv / cisco_c8000v: sourced from this homelab's older
//     libvirt-based labber project's lab.yml comments (labber/labs/
//     nexus9kv-test.lab.yml, c8000v-test.lab.yml) -- real trial-and-error
//     findings from actually booting these images, not guesses. See each
//     profile's own comment below for specifics. c8000v's serial0 was
//     empirically corrected 2026-08-04 (see its own comment below).
// f5_bigip_ve has no known-working *full* reference config on this node
// yet -- most values are reasonable BIG-IP VE-on-KVM defaults, edit here
// if they don't match what actually boots. serial0 is the one field
// that's now empirically confirmed (2026-08-04): added serial0:socket to
// a live clone and the console responded to input, so unlike the rest of
// this profile it's a known-working value, not a guess.
const STATIC_PROFILES = {
  paloalto_panos: {
    label: 'Palo Alto PAN-OS',
    guiPort: 443,
    defaultUsername: 'admin',
    defaultPassword: 'admin',
    hw: { bios: 'seabios', machine: 'q35', cores: 2, memory: 8192, cpu: 'host', diskBus: 'virtio0', scsihw: 'virtio-scsi-pci', nicModel: 'virtio', serial0: true, nics: 4, ostype: 'l26' },
  },
  paloalto_panorama: {
    label: 'Palo Alto Panorama',
    guiPort: 443,
    defaultUsername: 'admin',
    defaultPassword: 'admin',
    hw: { bios: 'seabios', machine: 'q35', cores: 4, memory: 16384, cpu: 'host', diskBus: 'virtio0', scsihw: 'virtio-scsi-pci', nicModel: 'virtio', serial0: true, nics: 1, ostype: 'l26' },
  },
  checkpoint_gaia: {
    label: 'Check Point Gaia',
    guiPort: 443,
    defaultUsername: 'admin',
    defaultPassword: null,
    // Built from the vendor's install ISO, not a pre-built qcow2 -- see
    // template-builder.js's buildFromIso(). Boots a blank disk from the
    // ISO (ide2, matching this homelab's real cp-fw-01/02 configs'
    // `boot: order=scsi0;ide2;net0`) so the Gaia installer can actually
    // run; the job stops at "awaiting-install" instead of auto-templating,
    // since finishing the interactive installer over console is a real
    // manual step no upload alone can skip.
    installFromIso: true,
    defaultDiskSizeGB: 65, // matches this homelab's real cp-fw-01/02 (scsi0 size=65G)
    hw: { bios: 'seabios', machine: '', cores: 2, memory: 8192, cpu: 'host', diskBus: 'scsi0', scsihw: 'lsi', nicModel: 'virtio', serial0: false, nics: 5, ostype: 'l26' },
  },
  f5_bigip_ve: {
    label: 'F5 BIG-IP VE',
    guiPort: 443,
    defaultUsername: 'admin',
    defaultPassword: 'admin',
    hw: { bios: 'seabios', machine: 'q35', cores: 4, memory: 8192, cpu: 'host', diskBus: 'scsi0', scsihw: 'virtio-scsi-single', nicModel: 'virtio', serial0: true, nics: 4, ostype: 'l26' },
  },
  fortios: {
    label: 'Fortinet FortiGate',
    guiPort: 443,
    defaultUsername: 'admin',
    defaultPassword: '',
    hw: { bios: 'seabios', machine: 'q35', cores: 2, memory: 2048, cpu: 'host', diskBus: 'scsi0', scsihw: 'virtio-scsi-single', nicModel: 'virtio', serial0: true, nics: 3, ostype: 'l26' },
  },
  fortimanager: {
    label: 'Fortinet FortiManager',
    guiPort: 443,
    defaultUsername: 'admin',
    defaultPassword: '',
    hw: { bios: 'seabios', machine: '', cores: 2, memory: 8192, cpu: 'host', diskBus: 'scsi0', scsihw: 'virtio-scsi-single', nicModel: 'virtio', serial0: true, nics: 1, ostype: 'l26' },
  },
  cisco_n9kv: {
    label: 'Cisco Nexus 9000v (NX-OSv)',
    guiPort: null, // CLI/SSH-managed, no primary HTTPS GUI
    defaultUsername: 'admin',
    defaultPassword: null, // NX-OSv forces an interactive password setup on first boot (POAP-style), no fixed default
    // From labber/labs/nexus9kv-test.lab.yml: this image hung indefinitely
    // at "Booting from Hard Disk..." with q35/virtio/legacy-BIOS defaults,
    // and again with machine:pc alone -- ruling out chipset alone. The
    // actual fix (confirmed on a real deployment, matches vendor Proxmox
    // deployment guidance): UEFI firmware (not legacy BIOS), a SATA disk
    // (NX-OSv's data plane doesn't support virtio NICs, and virtio/IDE
    // disks are unreliable too), and e1000 NICs specifically (applies to
    // the mgmt NIC too, not just data plane). RAM bumped to 10GB per
    // vendor guidance for 10.x releases. Console must be serial, not
    // VNC -- VGA output drops after the initial bootloader on this image.
    hw: { bios: 'ovmf', machine: 'q35', cores: 4, memory: 10240, cpu: 'host', diskBus: 'sata0', scsihw: '', nicModel: 'e1000', serial0: true, nics: 8, ostype: 'l26' },
  },
  cisco_c8000v: {
    label: 'Cisco Catalyst 8000V',
    guiPort: 443, // confirmed working: HTTPS GUI reachable
    defaultUsername: 'admin',
    defaultPassword: null, // IOS-XE day-0 config, no fixed default
    // From labber/labs/c8000v-test.lab.yml, confirmed working 2026-07-18:
    // boots cleanly, mgmt reachable via DHCP, HTTPS GUI works. UEFI
    // firmware is deliberate (this image's own filename signals a
    // "vga_efi" build -- legacy BIOS generally can't boot a UEFI/GPT+ESP
    // disk at all), virtio disk bus confirmed fine (unlike n9kv).
    // serial0 corrected 2026-08-04: originally assumed false here (this
    // being the "vga" build, the theory was console output only goes to
    // the VGA framebuffer) -- empirically wrong, added serial0:socket to
    // a live clone and it worked fine, so this app's serial console
    // feature is usable for c8000v after all, not just Proxmox's own
    // VNC/display console.
    hw: { bios: 'ovmf', machine: 'q35', cores: 4, memory: 8192, cpu: 'host', diskBus: 'virtio0', scsihw: 'virtio-scsi-pci', nicModel: 'virtio', serial0: true, nics: 4, ostype: 'l26' },
  },
  // cisco_ftd / cisco_fmc: no known-working reference config on this
  // homelab's own node yet (unlike the Cisco kinds above, which came from
  // real boot attempts) -- these values are transcribed from Cisco's own
  // published "Getting Started" KVM deployment guides for FTDv/FMCv
  // (vCPU/RAM minimums, i440fx machine type, virtio disk+NIC, the >=4-NIC
  // floor for FTDv: Management0/0, Diagnostic0/0, GigabitEthernet0/0,
  // GigabitEthernet0/1), not empirically confirmed by booting on real
  // hardware here. Edit these if they don't match what actually boots.
  cisco_ftd: {
    label: 'Cisco Firepower Threat Defense Virtual (FTDv)',
    guiPort: 443, // Firepower Device Manager (local per-device web UI) -- only reachable if FTDv is running in local-manager mode rather than FMC-managed
    defaultUsername: 'admin',
    defaultPassword: 'Admin123', // Cisco's documented factory default -- forces a password change + EULA accept on first CLI login
    hw: { bios: 'seabios', machine: '', cores: 4, memory: 8192, cpu: 'host', diskBus: 'virtio0', scsihw: 'virtio-scsi-pci', nicModel: 'virtio', serial0: true, nics: 4, ostype: 'l26' },
  },
  cisco_fmc: {
    label: 'Cisco Firepower Management Center Virtual (FMCv)',
    guiPort: 443,
    defaultUsername: 'admin',
    defaultPassword: 'Admin123', // same Cisco-documented factory default as FTDv, forced change on first login
    // Management-only appliance (like paloalto_panorama above) -- a single
    // NIC, no data-plane interfaces to wire into a flow.
    hw: { bios: 'seabios', machine: '', cores: 4, memory: 32768, cpu: 'host', diskBus: 'virtio0', scsihw: 'virtio-scsi-pci', nicModel: 'virtio', serial0: true, nics: 1, ostype: 'l26' },
  },
  // sonic_vs: SONiC virtual switch (sonic-vs.img), never booted on this
  // homelab's node yet -- values sourced from two places that partly
  // disagree, not from an empirical boot here:
  //   - sonic.software's own quick-start QEMU one-liner (`qemu-system-x86_64
  //     -machine q35 -m 2048 -smp 4 -hda sonic-vs.img -nographic -netdev
  //     user,id=sonic0,... -device e1000,netdev=sonic0 -cpu host -accel
  //     kvm`) -- gives q35/2GB/4 vCPU/serial console (nographic) and the
  //     documented default login admin/YourPaSsWoRd, but its `-hda` +
  //     `e1000` are just the simplest possible single-command incantation
  //     for a quick SSH-only smoke test, not necessarily the image's real
  //     preference.
  //   - sonic-net/sonic-mgmt's own vs-setup libvirt tooling (the project's
  //     actual multi-NIC testbed automation) instead uses virtio for both
  //     disk and NIC model -- SONiC's guest OS is Debian-based and ships
  //     virtio drivers, so virtio0/virtio-scsi-pci (this app's normal
  //     "just works" Linux-guest pattern, same as generic_qcow2 below) was
  //     chosen here over the literal `-hda`/`e1000` from the one-liner.
  //     **Not yet confirmed booting that way on real hardware -- if a
  //     clone won't boot, try diskBus: 'ide0'/nicModel: 'e1000' (the
  //     literally-documented quick-start values) instead.**
  // nics: 5 (net0 as SONiC's own eth0 mgmt interface, net1-4 as front-panel
  // data ports) is a starting default for a small T0-ish topology, not a
  // hard vendor minimum -- override per-node in the lab wizard/YAML for a
  // bigger port count.
  sonic_vs: {
    label: 'SONiC Virtual Switch (VS)',
    guiPort: null, // CLI/SSH-managed (no default web GUI; sonic-mgmt-framework's optional REST/gNMI northbound isn't a browser UI)
    defaultUsername: 'admin',
    defaultPassword: 'YourPaSsWoRd', // documented default, sonic.software's own how-to page
    hw: { bios: 'seabios', machine: 'q35', cores: 4, memory: 2048, cpu: 'host', diskBus: 'virtio0', scsihw: 'virtio-scsi-pci', nicModel: 'virtio', serial0: true, nics: 5, ostype: 'l26' },
  },
  // generic_qcow2 / generic_iso: not a specific vendor -- covers anything
  // that isn't one of the above (a plain Ubuntu/Debian server, a vendor's
  // official appliance qcow2 like Zabbix's, a FreeRADIUS box, ...), so the
  // "management lab" concept (SMS/Panorama/FMC/FortiManager plus ordinary
  // Linux services) doesn't need a fake vendor kind for every generic box.
  // Two entries rather than one "generic" kind with a runtime choice: this
  // app's build flow (template-builder.js's buildTemplate()) picks
  // qcow2-vs-iso purely off `installFromIso` on the *profile*, not per
  // request, and the frontend (templates.js) is already kind-agnostic about
  // it either way -- see labber-pve full-review plan, item 2.
  generic_qcow2: {
    label: 'Generic Linux (qcow2)',
    guiPort: null, // varies per use (SSH-managed by default; a specific app's own port, e.g. Zabbix's 80/443, is reachable via manual mgmt-ip entry same as any other kind)
    defaultUsername: 'root',
    defaultPassword: null, // depends entirely on the uploaded image (cloud-init image: no fixed password; a vendor appliance qcow2: whatever it documents)
    // Ordinary Linux-guest defaults, not sourced from any specific vendor
    // reference -- q35/seabios/virtio is the standard "just works" KVM
    // profile for a general-purpose Linux qcow2/cloud image.
    hw: { bios: 'seabios', machine: 'q35', cores: 2, memory: 2048, cpu: 'host', diskBus: 'virtio0', scsihw: 'virtio-scsi-pci', nicModel: 'virtio', serial0: true, nics: 2, ostype: 'l26' },
  },
  generic_iso: {
    label: 'Generic Linux (ISO install)',
    guiPort: null,
    defaultUsername: 'root',
    defaultPassword: null,
    // Same installer-boot shape as checkpoint_gaia above (blank disk +
    // CD-ROM, stops at "awaiting-install" for the interactive installer)
    // but with ordinary Linux-guest hw instead of Gaia's specific profile.
    installFromIso: true,
    defaultDiskSizeGB: 32,
    hw: { bios: 'seabios', machine: 'q35', cores: 2, memory: 2048, cpu: 'host', diskBus: 'virtio0', scsihw: 'virtio-scsi-pci', nicModel: 'virtio', serial0: true, nics: 2, ostype: 'l26' },
  },
};

// `version` is optional -- omitted (the common case: no lab YAML `version:`
// field, or a build request with no version yet resolved) falls back to
// `templates[kind]`, the default vmid a lab uses when it doesn't ask for a
// specific one. Given, it resolves from that kind's own entry in
// `templateVersions` instead -- see config-store.js's saveTemplateVersion
// for how that map gets populated.
function getProfile(kind, version) {
  const base = STATIC_PROFILES[kind];
  if (!base) return null;
  const config = configStore.get();
  const raw = version ? config.templateVersions[kind]?.[version] : config.templates[kind];
  return { ...base, templateId: raw ? parseInt(raw, 10) : null };
}

function requireProfile(kind, version) {
  const profile = getProfile(kind, version);
  if (!profile) throw new Error(`Unknown device kind: ${kind}`);
  if (!profile.templateId) {
    throw new Error(
      version
        ? `No template version "${version}" for kind "${kind}"`
        : `No template configured for kind "${kind}" -- set it on the Settings page`
    );
  }
  return profile;
}

function listKinds() {
  const config = configStore.get();
  return Object.keys(STATIC_PROFILES).map((kind) => {
    const p = getProfile(kind);
    return {
      kind,
      label: p.label,
      configured: !!p.templateId,
      templateId: p.templateId,
      hw: p.hw,
      installFromIso: !!p.installFromIso,
      defaultDiskSizeGB: p.defaultDiskSizeGB || null,
      // { [label]: vmid } -- lets the lab wizard offer a version picker and
      // the build modal warn about a label collision before starting a
      // (possibly multi-GB, multi-minute) build, without a second API call.
      versions: config.templateVersions[kind] || {},
    };
  });
}

module.exports = { getProfile, requireProfile, listKinds, STATIC_PROFILES };
