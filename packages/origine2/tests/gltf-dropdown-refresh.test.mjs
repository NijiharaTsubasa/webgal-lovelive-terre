import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';
import * as gltfFigure from '../src/utils/gltf/gltfFigure.ts';

async function componentHarness(file, modules = {}) {
  const hooks = [];
  let cursor = 0;
  let effects = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    Fragment: 'Fragment',
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      return hooks[index] ??= { current: initial };
    },
    useMemo(fn, deps) {
      const index = cursor++;
      if (!hooks[index] || deps.some((value, i) => value !== hooks[index].deps[i])) hooks[index] = { deps, value: fn() };
      return hooks[index].value;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!hooks[index] || deps.some((value, i) => value !== hooks[index].deps[i])) {
        hooks[index]?.cleanup?.();
        hooks[index] = { deps };
        effects.push(() => { hooks[index].cleanup = fn(); });
      }
    },
  };
  const { code } = await transform(await readFile(new URL(file, import.meta.url), 'utf8'), {
    loader: 'tsx', format: 'cjs', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
  });
  const { code: catalogCode } = await transform(await readFile(new URL('../src/hooks/gltf/useGltfCatalog.ts', import.meta.url), 'utf8'), {
    loader: 'ts', format: 'cjs',
  });
  const cache = new Map();
  let catalogHook;
  const requireModule = name => {
    if (name === 'react') return React;
    if (name in modules) return { __esModule: true, ...modules[name] };
    if (name === 'swr') return { __esModule: true, default(key, fetcher) {
      const id = JSON.stringify(key);
      let record = cache.get(id);
      if (!record) {
        record = { data: undefined, mutate: async () => { record.data = await fetcher(); return record.data; } };
        cache.set(id, record);
      }
      React.useEffect(() => { if (key && !record.data) void record.mutate().catch(() => {}); }, [id]);
      return record;
    } };
    if (name === '@/hooks/gltf/useGltfCatalog') {
      if (!catalogHook) {
        const exports = { exports: {} };
        vm.runInNewContext(catalogCode, { module: exports, exports: exports.exports, require: requireModule, AbortController, console });
        catalogHook = exports.exports;
      }
      return { __esModule: true, ...catalogHook };
    }
    if (name === '@lingui/macro') return { t: strings => strings.join('') };
    if (name.endsWith('.scss')) return { default: {} };
    return new Proxy({ __esModule: true, default: name.split('/').pop() }, { get: (target, key) => target[key] ?? String(key) });
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    React, module, exports: module.exports, AbortController, URL,
    window: { location: { origin: 'http://localhost' } }, console: { warn() {} },
    require: requireModule,
  });
  return {
    render(props) {
      cursor = 0;
      // The project provider owns monitoring; the panel consumes the same cache.
      if (catalogHook) catalogHook.default('test-game', true);
      return module.exports.default(props);
    },
    async flush() {
      const pending = effects;
      effects = [];
      pending.forEach(fn => fn());
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(tree.type === type ? [tree] : []), ...(tree.children ?? []).flatMap(child => nodes(child, type))];
}

const store = { use: new Proxy({}, { get: (_, key) => () => key === 'subPage' ? 'test-game' : key === 'cascaderDelimiters' ? ['/'] : () => {} }) };

test('native expression picker submits only a complete combination and does not enumerate combinations', async () => {
  const harness = await componentHarness('../src/components/gltf/GltfExpressionPicker.tsx', {
    '@/utils/gltf/gltfFigure': gltfFigure,
  });
  const selected = [];
  const props = { native: { eyes: ['Sad/左', 'Open'], mouths: ['Smile', 'A'], defaults: { eye: 'Open', closed: 'Smile', open: 'A' } },
    live2d: ['anon/sad01'], supportsLive2D: true, value: '', onValueChange: value => selected.push(value) };
  let tree = harness.render(props);
  nodes(tree, 'Popover')[0].props.onOpenChange(null, { open: true });
  tree = harness.render(props);
  assert.equal(nodes(tree, 'SearchableCascader').length, 1, 'default browser is Live2D');
  nodes(tree, 'Button').find(node => node.children.includes('3D')).props.onClick();
  tree = harness.render(props);
  assert.deepEqual(selected, [], 'switching browser does not modify script');
  assert.equal(nodes(tree, 'Button').length, 9, 'only eye and two mouth columns are rendered');
  nodes(tree, 'Button').find(node => node.children.includes('Sad/左')).props.onClick();
  tree = harness.render(props);
  assert.deepEqual(selected, []);
  nodes(tree, 'Button').filter(node => node.children.includes('Smile'))[0].props.onClick();
  tree = harness.render(props);
  assert.deepEqual(selected, []);
  nodes(tree, 'Button').filter(node => node.children.includes('A'))[1].props.onClick();
  assert.deepEqual(selected, ['3d:Sad%2F%E5%B7%A6/Smile/A']);
});

test('native expression picker handles capability, empty lists, saved choice and absent domains', async () => {
  const harness = await componentHarness('../src/components/gltf/GltfExpressionPicker.tsx', {
    '@/utils/gltf/gltfFigure': gltfFigure,
  });
  const selected = [];
  let props = { native: { eyes: ['Open'], mouths: [], defaults: { eye: 'Open' } }, live2d: [],
    supportsLive2D: true, value: '', onValueChange: value => selected.push(value) };
  let tree = harness.render(props);
  assert.equal(nodes(tree, 'SearchableCascader').length, 0, 'empty Live2D list defaults to native');
  props = { ...props, live2d: ['anon/sad01'], value: '3d:Open//' };
  tree = harness.render(props);
  assert.equal(nodes(tree, 'SearchableCascader').length, 0, 'saved native expression determines browser');
  props = { ...props, value: 'anon/sad01' };
  tree = harness.render(props);
  assert.equal(nodes(tree, 'SearchableCascader').length, 1);
  props = { ...props, supportsLive2D: false };
  tree = harness.render(props);
  assert.equal(nodes(tree, 'Button').filter(node => ['3D', 'Live2D'].some(label => node.children.includes(label))).length, 0);
  assert.equal(nodes(tree, 'SearchableCascader').length, 0);
  nodes(tree, 'Popover')[0].props.onOpenChange(null, { open: true });
  tree = harness.render(props);
  nodes(tree, 'Button').find(node => node.children.includes('Open')).props.onClick();
  tree = harness.render(props);
  nodes(tree, 'Button').filter(node => node.children.includes('无'))[0].props.onClick();
  tree = harness.render(props);
  nodes(tree, 'Button').filter(node => node.children.includes('无'))[1].props.onClick();
  assert.deepEqual(selected, ['3d:Open//']);
});

test('model picker reopens at the containing directory and keeps its toolbar while switching roots', async () => {
  const harness = await componentHarness('../src/pages/editor/ChooseFile/ChooseFile.tsx', {
    '@/store/useEditorStore': { default: store },
    '@fluentui/react-icons': { bundleIcon: () => 'Icon' },
    '../../../hooks/useValue': { useValue: value => ({ value, set() {} }) },
  });
  const toolbar = { type: 'span', props: {}, children: ['切换立绘类型'] };
  const props = { basePath: ['3d', 'figure'], selectedFilePath: 'llas/ch0001/config.json',
    chooseModelDirectory: true, toolbar, onChange() {} };
  let tree = harness.render(props);
  assert.deepEqual([...nodes(tree, 'Assets')[0].props.selectedFilePath], ['llas', 'ch0001']);
  assert.ok(nodes(tree, 'span').some(node => node.children.includes('切换立绘类型')));
  const originalKey = nodes(tree, 'Assets')[0].props.key;
  tree = harness.render({ ...props, basePath: ['figure'], selectedFilePath: undefined, chooseModelDirectory: false });
  assert.notEqual(nodes(tree, 'Assets')[0].props.key, originalKey);
  assert.equal(nodes(tree, 'Assets')[0].props.selectedFilePath, undefined);
  assert.ok(nodes(tree, 'span').some(node => node.children.includes('切换立绘类型')));
  tree = harness.render({ ...props, chooseModelDirectory: false });
  assert.deepEqual([...nodes(tree, 'Assets')[0].props.selectedFilePath], ['llas', 'ch0001', 'config.json']);
});

test('ordinary and cascaded selectors refresh on opening, not closing or selecting', async () => {
  let opened = 0;
  const harness = await componentHarness('../src/pages/editor/GraphicalEditor/components/SearchableCascader.tsx', {
    '@/store/useEditorStore': { default: store },
    '../utils/getCascaderOptions': { getCascaderOptions: () => new Map(), getCascaderLevels: () => [] },
    lodash: { debounce: fn => fn, escapeRegExp: value => value },
  });
  const props = { optionList: ['a'], value: 'a', onValueChange() {}, onOpen() { opened++; } };
  let tree = harness.render(props);
  nodes(tree, 'WheelDropdown')[0].props.onOpenChange(null, { open: true });
  nodes(tree, 'WheelDropdown')[0].props.onOpenChange(null, { open: false });
  assert.equal(opened, 1);
  const popover = nodes(tree, 'Popover')[0];
  popover.props.onOpenChange(null, { open: true });
  assert.equal(opened, 2);
  tree = harness.render(props);
  nodes(tree, 'Popover')[0].props.onOpenChange(null, { open: false });
  assert.equal(opened, 2);
});

test('motion descriptions display and search without changing selected values or cascader paths', async () => {
  const motion = 'hasunosora/mot_00_02070';
  const harness = await componentHarness('../src/pages/editor/GraphicalEditor/components/SearchableCascader.tsx', {
    '@/store/useEditorStore': { default: store },
    '../utils/getCascaderOptions': {
      getCascaderOptions: () => new Map([['hasunosora/*', { value: 'hasunosora/', children: new Map([
        ['mot_00_02070', { value: motion, children: new Map() }],
      ]) }]]),
      getCascaderLevels: () => [],
    },
    lodash: { debounce: fn => fn, escapeRegExp: value => value },
  });
  const selected = [];
  let props = { optionList: [motion, 'anon/angry01'], optionDescriptions: new Map([[motion, '被拖走']]),
    value: motion, onValueChange: value => selected.push(value) };
  let tree = harness.render(props);
  const wheel = nodes(tree, 'WheelDropdown')[0];
  assert.equal(wheel.props.options.get(motion), motion);
  const renderedLabel = wheel.props.renderOption(motion, motion);
  assert.deepEqual(nodes(renderedLabel, 'span').slice(1).map(span => span.children[0]), [motion, '被拖走']);
  assert.equal(nodes(tree, 'WheelDropdown')[0].props.options.get('anon/angry01'), 'anon/angry01');
  let options = nodes(tree, 'Option');
  assert.equal(options[0].props.text, 'hasunosora/*');
  options[0].props.onClick();
  tree = harness.render(props);
  options = nodes(tree, 'Option');
  const leaf = options.find(option => option.props.value === motion);
  assert.equal(leaf.props.text, 'mot_00_02070 被拖走');
  leaf.props.onClick();
  assert.deepEqual(selected, [motion]);
  nodes(tree, 'input').find(input => input.props.type === 'text').props.onChange({ target: { value: '被拖走' } });
  tree = harness.render(props);
  options = nodes(tree, 'Option');
  assert.equal(options.length, 1);
  assert.equal(options[0].props.text, `${motion} 被拖走`);
  options[0].props.onClick();
  assert.deepEqual(selected, [motion, motion]);
  nodes(tree, 'input').find(input => input.props.type === 'text').props.onChange({ target: { value: 'HASUNOSORA 被' } });
  tree = harness.render(props);
  assert.equal(nodes(tree, 'Option').length, 1);
  props = { ...props, optionDescriptions: new Map([[motion, '站立']]) };
  nodes(tree, 'input').find(input => input.props.type === 'text').props.onChange({ target: { value: '站立' } });
  tree = harness.render(props);
  assert.equal(nodes(tree, 'Option')[0].props.text, `${motion} 站立`);
});

test('wheel dropdown renders separate labels while selecting original names', async () => {
  const harness = await componentHarness('../src/pages/editor/GraphicalEditor/components/WheelDropdown.tsx', {
    'lodash/debounce': { default: fn => fn },
  });
  const selected = [];
  const tree = harness.render({ options: new Map([['hasunosora/drag', 'hasunosora/drag']]), value: 'hasunosora/drag',
    renderOption: (value, label) => ({ value, label, description: '被拖走' }), onValueChange: value => selected.push(value) });
  const dropdown = nodes(tree, 'Dropdown')[0];
  assert.equal(dropdown.props.button.children.description, '被拖走');
  assert.equal(nodes(tree, 'Option')[0].props.value, 'hasunosora/drag');
  dropdown.props.onOptionSelect(null, { optionValue: 'hasunosora/drag' });
  assert.deepEqual(selected, ['hasunosora/drag']);
});

test('glTF dropdowns receive latest lists, unchanged refresh avoids reload, failures preserve options', async () => {
  let revision = 1;
  let fail = false;
  let enabled = true;
  let posts = 0;
  let modelReads = 0;
  let refreshes = 0;
  const modelPath = 'models/config.json';
  const resources = () => [
    { type: 'model', name: 'model', config: `figure/${modelPath}` },
    { type: 'garupa-motion', name: revision === 1 ? 'old' : 'extra/new', config: 'figure/params/config.json' },
    { type: 'motion', name: 'hasunosora/drag', description: revision === 1 ? '被拖走' : '被拉走', config: 'figure/motions/config.json' },
  ];
  const model = () => ({ components: [{ type: 'model', role: 'integrated', model: 'model.glb', expressionGroups: [{ type: 'eye', states: [{ name: revision === 1 ? 'Sad' : 'Smile' }] }] }] });
  const axios = {
    async get(url) {
      if (url.endsWith('webgal-engine.json')) return { data: { id: 'webgal-lovelive.lovelive' } };
      modelReads++;
      return { data: model() };
    },
    async post() {
      posts++;
      if (fail) throw new Error('temporarily unavailable');
      return { data: { enabled, revision, resources: enabled ? resources() : [] } };
    },
  };
  const harness = await componentHarness('../src/pages/editor/GraphicalEditor/SentenceEditor/ChangeFigure.tsx', {
    '@/store/useEditorStore': { default: store }, axios: { default: axios },
    '../../../../hooks/useValue': { useValue: value => ({ value, set() {} }) },
    '../utils/getArgByKey': { getArgByKey: () => '' },
    '../../ChooseFile/chooseFileConfig': { extNameMap: new Map() },
    '@/hooks/useEaseTypeOptions': { useEaseTypeOptions: () => new Map() },
    '@/hooks/useGlobalEffectEditor': { useGlobalEffectEditor: () => () => {} },
    '@/utils/gltf/gltfFigure': gltfFigure,
    '@/utils/eventBus': { eventBus: { emit() { refreshes++; } } },
  });
  const props = { sentence: { content: modelPath, args: [] }, onSubmit() {} };
  async function settle() {
    let tree;
    for (let i = 0; i < 4; i++) { tree = harness.render(props); await harness.flush(); }
    return harness.render(props);
  }
  let tree = await settle();
  let selectors = nodes(tree, 'SearchableCascader');
  assert.deepEqual([...selectors[0].props.optionList], ['hasunosora/drag', 'old']);
  assert.equal(selectors[0].props.optionDescriptions.get('hasunosora/drag'), '被拖走');
  assert.deepEqual([...nodes(tree, 'GltfExpressionPicker')[0].props.native.eyes], ['Sad']);
  const readsBefore = modelReads;
  selectors[0].props.onOpen();
  nodes(tree, 'GltfExpressionPicker')[0].props.onOpen();
  tree = await settle();
  assert.equal(posts, 2, 'concurrent dropdown opening reuses one request');
  assert.equal(modelReads, readsBefore, 'unchanged catalog does not reload model config');
  assert.equal(refreshes, 0);
  revision = 2;
  nodes(tree, 'SearchableCascader')[0].props.onOpen();
  tree = await settle();
  selectors = nodes(tree, 'SearchableCascader');
  assert.deepEqual([...selectors[0].props.optionList], ['extra/new', 'hasunosora/drag']);
  assert.equal(selectors[0].props.optionDescriptions.get('hasunosora/drag'), '被拉走');
  assert.deepEqual([...nodes(tree, 'GltfExpressionPicker')[0].props.native.eyes], ['Smile']);
  assert.equal(refreshes, 1);
  revision = 3;
  nodes(tree, 'GltfExpressionPicker')[0].props.onOpen();
  tree = await settle();
  assert.equal(modelReads, readsBefore + 2, 'new revision reloads model-owned states even when catalog entries are unchanged');
  fail = true;
  nodes(tree, 'GltfExpressionPicker')[0].props.onOpen();
  tree = await settle();
  assert.deepEqual([...nodes(tree, 'GltfExpressionPicker')[0].props.native.eyes], ['Smile']);
  fail = false;
  enabled = false;
  nodes(tree, 'GltfExpressionPicker')[0].props.onOpen();
  tree = await settle();
  assert.equal(nodes(tree, 'SearchableCascader').length, 0, 'disabled engine response removes glTF selectors');
  assert.equal(refreshes, 3, 'glTF-enabled to disabled transition refreshes the running preview');
});

test('a readable glTF model keeps its animation panel when an adapter config is unavailable', async () => {
  const harness = await componentHarness('../src/pages/editor/GraphicalEditor/SentenceEditor/ChangeFigure.tsx', {
    '@/store/useEditorStore': { default: store },
    axios: { default: {
      async post() { return { data: { enabled: true, revision: 1, resources: [
        { type: 'garupa-expression-adapter', name: 'face', config: '3d/runtime/missing/config.json' },
        { type: 'motion', name: 'llas/idle.motionbin', config: '3d/motion/llas/idle.motionbin' },
      ] } }; },
      async get(url) {
        if (url.includes('/runtime/')) throw Error('adapter unavailable');
        return { data: { components: [{ type: 'model', role: 'integrated', model: 'model.glb', motionGroup: 'llas', expressionGroups: [{ type: 'eye', states: [{ name: 'Smile' }] }] }] } };
      },
    } },
    '../../../../hooks/useValue': { useValue: value => ({ value, set() {} }) },
    '../utils/getArgByKey': { getArgByKey: () => '' },
    '../../ChooseFile/chooseFileConfig': { extNameMap: new Map() },
    '@/hooks/useEaseTypeOptions': { useEaseTypeOptions: () => new Map() },
    '@/hooks/useGlobalEffectEditor': { useGlobalEffectEditor: () => () => {} },
    '@/utils/gltf/gltfFigure': gltfFigure,
    '@/utils/eventBus': { eventBus: { emit() {} } },
  });
  const props = { sentence: { content: 'ch0001/config.json', args: [] }, onSubmit() {} };
  for (let i = 0; i < 5; i++) { harness.render(props); await harness.flush(); }
  const tree = harness.render(props);
  const selectors = nodes(tree, 'SearchableCascader');
  assert.equal(selectors.length, 1, 'glTF motion controls must not become static image controls');
  assert.deepEqual([...selectors[0].props.optionList], ['llas/idle.motionbin']);
  assert.deepEqual([...nodes(tree, 'GltfExpressionPicker')[0].props.native.eyes], ['Smile']);
});

test('selecting a model copied after the picker opened refreshes the parameter panel catalog', async () => {
  let revision = 7;
  const modelPath = 'new';
  const props = { sentence: { content: 'old.png', args: [] }, onSubmit() {} };
  const harness = await componentHarness('../src/pages/editor/GraphicalEditor/SentenceEditor/ChangeFigure.tsx', {
    '@/store/useEditorStore': { default: store },
    axios: { default: {
      async post(url) { if (url.endsWith('selectGltfModel')) return { data: {} }; return { data: { enabled: true, revision, resources: revision === 7 ? [] : [
        { type: 'model', name: 'new', config: `figure/${modelPath}` },
        { type: 'motion', name: 'llas/idle.motionbin', config: '3d/motion/llas/idle.motionbin' },
      ] } }; },
      async get() { return { data: { components: [{ type: 'model', role: 'integrated', model: 'model.glb', expressionGroups: [{ type: 'eye', states: [{ name: 'Smile' }] }] }] } }; },
    } },
    '../../../../hooks/useValue': { useValue: value => ({ value, set(next) { if (value === props.sentence.content) props.sentence.content = next; } }) },
    '../utils/getArgByKey': { getArgByKey: () => '' },
    '../../ChooseFile/chooseFileConfig': { extNameMap: new Map() },
    '@/hooks/useEaseTypeOptions': { useEaseTypeOptions: () => new Map() },
    '@/hooks/useGlobalEffectEditor': { useGlobalEffectEditor: () => () => {} },
    '@/utils/combineSubmitString': { combineSubmitString: () => '' },
    '@/utils/gltf/gltfFigure': gltfFigure,
    '@/utils/eventBus': { eventBus: { emit() {} } },
  });
  async function settle() {
    for (let i = 0; i < 4; i++) { harness.render(props); await harness.flush(); }
    return harness.render(props);
  }
  let tree = await settle();
  await nodes(tree, 'ChooseFile')[0].props.onOpen();
  tree = await settle();
  // The picker sees revision 8 after copying, while this panel still has 7.
  revision = 8;
  const picker = nodes(tree, 'ChooseFile')[0];
  assert.equal(nodes(tree, 'Button').filter(button => button.children.includes('2D')).length, 0, 'type switch belongs inside the picker');
  const typeButtons = nodes(picker.props.toolbar, 'Button');
  assert.deepEqual(typeButtons.map(button => button.children[0]), ['2D', '3D']);
  assert.equal(typeButtons[0].props['aria-pressed'], true);
  assert.equal(typeButtons[1].props['aria-pressed'], false);
  typeButtons[1].props.onClick();
  tree = await settle();
  const selectedTypeButtons = nodes(nodes(tree, 'ChooseFile')[0].props.toolbar, 'Button');
  assert.equal(selectedTypeButtons[0].props['aria-pressed'], false);
  assert.equal(selectedTypeButtons[1].props['aria-pressed'], true);
  await nodes(tree, 'ChooseFile')[0].props.onChange({ name: modelPath, isDir: true });
  tree = await settle();
  const selectors = nodes(tree, 'SearchableCascader');
  assert.equal(selectors.length, 1, 'new model must immediately show glTF motion controls without reopening the picker');
  assert.deepEqual([...selectors[0].props.optionList], ['llas/idle.motionbin']);
  assert.deepEqual([...nodes(tree, 'GltfExpressionPicker')[0].props.native.eyes], ['Smile']);
});

test('Live2D selectors do not refresh glTF catalogs or reload their model on catalog updates', async () => {
  let modelReads = 0;
  let posts = 0;
  let refreshes = 0;
  const harness = await componentHarness('../src/pages/editor/GraphicalEditor/SentenceEditor/ChangeFigure.tsx', {
    '@/store/useEditorStore': { default: store },
    axios: { default: {
      async get(url) {
        if (url.endsWith('webgal-engine.json')) return { data: { id: 'webgal-lovelive.lovelive' } };
        modelReads++;
        return { data: { motions: { idle: [] }, expressions: [{ name: 'Sad' }] } };
      },
      async post() { posts++; return { data: { enabled: false, revision: posts, resources: [] } }; },
    } },
    '../../../../hooks/useValue': { useValue: value => ({ value, set() {} }) },
    '../utils/getArgByKey': { getArgByKey: () => '' },
    '../../ChooseFile/chooseFileConfig': { extNameMap: new Map() },
    '@/hooks/useEaseTypeOptions': { useEaseTypeOptions: () => new Map() },
    '@/hooks/useGlobalEffectEditor': { useGlobalEffectEditor: () => () => {} },
    '@/utils/gltf/gltfFigure': gltfFigure, '@/utils/eventBus': { eventBus: { emit() { refreshes++; } } },
  });
  const props = { sentence: { content: 'anon/model.json', args: [] }, onSubmit() {} };
  let tree;
  for (let i = 0; i < 4; i++) { tree = harness.render(props); await harness.flush(); }
  tree = harness.render(props);
  const selectors = nodes(tree, 'SearchableCascader');
  assert.equal(selectors.length, 2);
  assert.equal(selectors[0].props.onOpen, undefined);
  assert.equal(selectors[0].props.optionDescriptions, undefined);
  assert.equal(selectors[1].props.onOpen, undefined);
  assert.deepEqual([...selectors[0].props.optionList], ['idle']);
  assert.equal(modelReads, 1);
  nodes(tree, 'ChooseFile').find(node => node.props.onOpen).props.onOpen();
  for (let i = 0; i < 4; i++) { tree = harness.render(props); await harness.flush(); }
  assert.equal(posts, 2);
  assert.equal(modelReads, 1);
  assert.equal(refreshes, 0, 'disabled-to-disabled revision changes must not refresh native Live2D preview');
});

test('shared catalog conditionally retains resources and issues, clears recovered errors, and merges simultaneous requests', async () => {
  const { code } = await transform(await readFile(new URL('../src/hooks/gltf/useGltfCatalog.ts', import.meta.url), 'utf8'), {
    loader: 'ts', format: 'cjs',
  });
  let reply = { enabled: true, revision: 1, resources: [{ type: 'motion', name: 'idle', config: 'motion.json' }],
    issues: ['sample'], indexing: true, error: 'retry' };
  let fetcher, options, stored;
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require(name) {
    if (name === 'react') return { useCallback: fn => fn, useRef: () => ({}), useEffect() {} };
    if (name === 'swr') return { __esModule: true, default(key, read, config) {
      fetcher = read; options = config; return { data: stored, mutate: read };
    } };
    if (name === 'axios') return { __esModule: true, default: { async post(url, body) { calls.push(body); return { data: reply }; } } };
    if (name === '@/utils/eventBus') return { eventBus: { emit() {} } };
    return {};
  } });
  module.exports.default('project', true);
  assert.equal(options.refreshInterval({ indexing: true }), 750);
  assert.equal(options.refreshInterval({ indexing: false }), 5000);
  stored = await fetcher();
  assert.equal('revision' in calls[0], false, 'a new cache always asks for a full snapshot');
  reply = { enabled: true, revision: 1, indexing: false, unchanged: true };
  module.exports.default('project', true);
  const [first, second] = await Promise.all([fetcher(), fetcher()]);
  assert.equal(calls.length, 2, 'concurrent consumers reuse one pending request');
  assert.equal(calls[1].revision, 1);
  assert.equal(first.resources, stored.resources);
  assert.equal(first.issues, stored.issues);
  assert.equal(first.error, undefined);
  assert.equal(first.indexing, false);
  assert.equal(first, second);
  module.exports.default('other-project');
  reply = { enabled: false, revision: 2, resources: [] };
  await fetcher();
  assert.equal('revision' in calls[2], false, 'a different project cannot inherit a previous revision');
  assert.equal(options.refreshInterval, 0, 'picker consumers do not establish their own polling loops');
});

test('project session renews its lease and releases it on tab hide or component cleanup', async () => {
  const { code } = await transform(await readFile(new URL('../src/hooks/gltf/useGltfCatalog.ts', import.meta.url), 'utf8'), {
    loader: 'ts', format: 'cjs',
  });
  const effects = [], calls = [], releases = [];
  const timers = new Map(), events = new Map();
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, AbortController, console,
    window: {
      setInterval(fn, ms) { timers.set(ms, fn); return ms; },
      clearInterval(id) { timers.delete(id); },
      addEventListener(name, fn) { events.set(name, fn); },
      removeEventListener(name) { events.delete(name); },
    },
    fetch(url, options) { releases.push(JSON.parse(options.body)); assert.equal(options.keepalive, true); return Promise.resolve({}); },
    require(name) {
      if (name === 'react') return { useCallback: fn => fn, useRef: () => ({}), useEffect: fn => effects.push(fn) };
      if (name === 'swr') return { __esModule: true, default: () => ({ mutate() {} }) };
      if (name === 'axios') return { __esModule: true, default: { async post(url, body, options) { calls.push({ body, signal: options.signal }); return { data: {} }; } } };
      if (name === 'uuid') return { v4: () => 'test-session' };
      if (name === '@/utils/eventBus') return { eventBus: { emit() {} } };
      return {};
    },
  });
  module.exports.useGltfCatalogSession('project');
  const cleanup = effects[0]();
  assert.equal(calls[0].body.active, true);
  assert.equal(calls[0].body.gameName, 'project');
  timers.get(10000)();
  assert.equal(calls.length, 2);
  events.get('pagehide')();
  assert.equal(releases.at(-1).active, false);
  events.get('pageshow')();
  assert.equal(calls.length, 3, 'restoring a cached tab immediately renews its lease');
  cleanup();
  assert.equal(timers.size, 0);
  assert.equal(events.size, 0);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(releases.at(-1).sessionId, 'test-session');
  assert.equal(releases.at(-1).active, false);
});
