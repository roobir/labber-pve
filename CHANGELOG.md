# Changelog

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
