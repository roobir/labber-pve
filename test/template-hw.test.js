const test = require('node:test');
const assert = require('node:assert');
const { freshLabsDir } = require('./helpers');

freshLabsDir();
const configStore = require('../lib/config-store');
const vendors = require('../lib/vendor-profiles');
const { parseHwOverride } = require('../lib/template-preflight');

test('a template version keeps its own cores/memory; others keep the profile', () => {
  configStore.saveTemplateVersion('generic_qcow2', 'zabbix', 201);
  configStore.saveTemplateVersion('generic_qcow2', 'radius', 202);
  configStore.setTemplateHw(201, { cores: 4, memory: 8192 });

  assert.deepStrictEqual(pick(vendors.getProfile('generic_qcow2', 'zabbix').hw), { cores: 4, memory: 8192 });
  assert.deepStrictEqual(pick(vendors.getProfile('generic_qcow2', 'radius').hw), { cores: 2, memory: 2048 });
  // The default is the last build (radius), so a node with no version gets its size.
  assert.deepStrictEqual(pick(vendors.getProfile('generic_qcow2').hw), { cores: 2, memory: 2048 });
  // Everything else in the profile is untouched.
  assert.strictEqual(vendors.getProfile('generic_qcow2', 'zabbix').hw.diskBus, 'virtio0');
});

test('only one of cores/memory can be set; a blank override forgets the entry', () => {
  configStore.setTemplateHw(202, { memory: 4096 });
  assert.deepStrictEqual(pick(vendors.getProfile('generic_qcow2', 'radius').hw), { cores: 2, memory: 4096 });
  configStore.setTemplateHw(202, {});
  assert.strictEqual(configStore.get().templateHw['202'], undefined);
  assert.deepStrictEqual(pick(vendors.getProfile('generic_qcow2', 'radius').hw), { cores: 2, memory: 2048 });
});

test('listKinds reports each version size and the kind default', () => {
  const k = vendors.listKinds().find((x) => x.kind === 'generic_qcow2');
  assert.strictEqual(k.customHw, true);
  assert.deepStrictEqual(k.defaultHw, { cores: 2, memory: 2048 });
  assert.deepStrictEqual(k.versionHw.zabbix, { cores: 4, memory: 8192 });
  assert.deepStrictEqual(k.versionHw.radius, { cores: 2, memory: 2048 });
  assert.strictEqual(vendors.listKinds().find((x) => x.kind === 'paloalto_panos').customHw, false);
});

test('a settings save leaves template sizes alone', () => {
  configStore.save({ guiDomain: 'gui.example.test' });
  assert.deepStrictEqual(configStore.get().templateHw['201'], { cores: 4, memory: 8192 });
});

test('build sizes: generic kinds only, whole numbers above 0, blanks ignored', () => {
  assert.deepStrictEqual(parseHwOverride('generic_iso', { cores: '8', memory: '16384' }), { hwOverride: { cores: 8, memory: 16384 }, errors: [] });
  assert.deepStrictEqual(parseHwOverride('generic_iso', { cores: '', memory: undefined }), { hwOverride: {}, errors: [] });
  assert.strictEqual(parseHwOverride('generic_qcow2', { cores: '1.5' }).errors.length, 1);
  assert.strictEqual(parseHwOverride('generic_qcow2', { memory: '0' }).errors.length, 1);
  assert.match(parseHwOverride('paloalto_panos', { cores: '4' }).errors[0], /per node/);
  assert.deepStrictEqual(parseHwOverride('paloalto_panos', {}).errors, []);
});

function pick(hw) {
  return { cores: hw.cores, memory: hw.memory };
}
