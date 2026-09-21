// PVE validates several VM `name` fields (create, clone, template build) as a
// DNS hostname (letters/digits/hyphens/dots only) -- rejects underscores
// with a somewhat cryptic "does not look like a valid DNS name" error.
// Anything user-supplied that ends up in one of those fields (a lab node
// name typed into the wizard or hand-edited YAML, a device kind string like
// "paloalto_panos", a template name) needs normalizing first. Shared by
// template-builder.js and lab-manager.js rather than duplicated -- both hit
// this exact error independently before this existed.
// DNS labels cap at 63 bytes (RFC 1035) -- labName is already restricted to
// [a-zA-Z0-9_-] and kept short by createLab(), but nodeName is a free-form
// YAML map key with no length limit enforced anywhere, so `labber-pve-
// <labName>-<nodeName>` could in principle exceed whatever PVE's own DNS-name
// validation on the `name` field allows, producing a cryptic clone failure
// instead of a clear one. Truncated (not rejected) since callers only use
// this for a display-ish VM name, not an identifier anything else keys off
// of -- re-trimmed after slicing in case truncation lands mid-separator.
const MAX_LENGTH = 63;

function toDnsSafeName(raw) {
  return (
    String(raw)
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, MAX_LENGTH)
      .replace(/[-.]+$/g, '') || 'vm'
  );
}

module.exports = { toDnsSafeName };
