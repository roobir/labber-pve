// Static text for the runbook editor: a starter template for new runbooks
// and the syntax reference shown under "syntax help".
window.RunbookHelp = {
  starter: `title: My runbook
vendor: f5_bigip_ve

inputs:
  - { id: target, type: target, kind: f5_bigip_ve, label: F5 node }
  - { id: password, type: store, storeType: secret, default: password-simple, label: Password }

steps:
  - id: version
    name: Read the software version
    http:
      path: /mgmt/tm/sys/version
      auth: { user: admin, password: "{{inputs.password}}" }
`,

  reference: `inputs (asked for when the runbook is run):
  { id, type, label, default, optional }
  type: string | secret | number | text | select (options: [...])
        target (a deployed lab node; kind: filters by vendor)
        store  (a Store entry; storeType: secret | text | license)

Use values anywhere in a step:
  {{inputs.id}}                a value the user entered
  {{inputs.license.regkey}}    a field of a license entry (regkey, licenseText,
                               addOnKeys, uuid, mac)
  {{store.password-simple}}    a Store entry by name
  {{steps.stepid.out.name}}    something an earlier step captured
  {{... | b64}} {{... | url}}  encode a value (base64 / URL)
  {{inputs.prefix | netmask}}  24 -> 255.255.255.0

Every step has an id, an optional name, and ONE of:

  console:                      type into the node's serial console
    - expect: "login:"          wait for text (case-insensitive regex)
      timeout: 600              seconds (default 60)
      nudge: 10                 press Enter every 10s while waiting
      optional: true            carry on if it never shows up
      as: ip                    keep regex group 1 as steps.<id>.out.ip
      send: root                then type this + Enter (raw: true = no Enter)
    - sleep: 5
    - paste: |                  type a block of lines (a config)
        config system interface
        ...
      failOn: "command parse error"   abort if the device prints this
      lineDelay: 0.03   settle: 5        pacing / seconds of silence = done

  http:                         call the node's management API
    method: POST
    path: /mgmt/tm/sys/license
    auth: { user: admin, password: "{{...}}" }
    query: { type: op }         headers: { X-Key: "..." }
    json: { ... }               or body: "raw text"
    expect: 200                 or { status: 200, match: "regex" }
    timeout: 120                seconds for this request
    retry: { on: [404, 503], match: "busy", every: 10, timeout: 600 }
                                ask again while the device is not ready
    poll: { every: 10, timeout: 600, initialDelay: 30,
            until: { status: 200 } }     keep trying until it passes
    extract: { name: { json: "a.b" } }   or { regex: "<k>(.+?)</k>" }

  lab:                          act on labber-pve itself
    setMgmtIp: { ip: "...", port: 443 }
    assertIdentity: { uuid: "...", mac: "..." }

  store:                        write a text value into the Store
    save: { name: "...", value: "{{steps.x.out.y}}", group: lab,
            overwrite: "{{inputs.overwrite}}" }   (yes/true to replace)

  wait: 30                      pause for 30 seconds

Optional on any step:  when: { path: inputs.method, equals: online }
                       (add  not: true  to run unless it equals)
                       when: { path: steps.x.out.y, exists: false }
                       continueOnError: true     target: <another target input>`,
};
