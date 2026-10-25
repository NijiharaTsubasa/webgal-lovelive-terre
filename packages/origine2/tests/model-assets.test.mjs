import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { modelAssetMap, modelPreview, createModelPreviewLoader, scheduleModelPreview } from '../src/utils/gltf/modelAssets.ts';

const root = ['games', '新的 游戏', 'game'];
const model = { type: 'model', name: '角色', description: '完整说明\n第二行', config: '3d/figure/分组/%E6%A8%A1%E5%9E%8B%20%25/config.json' };
const preview = 'data:image/webp;base64,QUJD';
const config = value => ({ components: [{ type: 'model', role: 'integrated', name: '角色', preview: value }] });

test('maps only config and its direct directory with decoded Chinese, spaces and percent paths', () => {
  const map = modelAssetMap(root, [model, { type: 'motion', name: '动作', config: 'figure/shared/config.json' }], true);
  assert.deepEqual([...map.keys()], ['3d/figure/分组/模型 %/config.json', '3d/figure/分组/模型 %']);
  assert.equal(map.get('3d/figure/分组/模型 %').description, '完整说明\n第二行');
  assert.equal(map.get('3d/figure/分组/模型 %').configUrl, '/games/%E6%96%B0%E7%9A%84%20%E6%B8%B8%E6%88%8F/game/3d/figure/分组/%E6%A8%A1%E5%9E%8B%20%25/config.json'.replace('分组', '%E5%88%86%E7%BB%84'));
  assert.equal(map.has('figure/分组'), false);
  assert.deepEqual([...modelAssetMap([...root, '3d', 'figure'], [model], true).keys()], ['分组/模型 %/config.json', '分组/模型 %']);
  assert.equal(modelAssetMap(root, [model], false).size, 0);
  assert.equal(modelAssetMap(['templates', 'test', 'game'], [model], true).size, 0);
  assert.equal(modelAssetMap(root, [{ ...model, config: 'https://other.invalid/figure/a/config.json' }, { ...model, config: '../figure/a/config.json' }], true).size, 0);
});

test('optional preview accepts only the single matching integrated model WebP data URL', () => {
  assert.equal(modelPreview(config(preview), '角色'), preview);
  assert.equal(modelPreview(config(undefined), '角色'), undefined);
  assert.equal(modelPreview(config('https://other/image.webp'), '角色'), undefined);
  assert.equal(modelPreview(config(preview), '别的角色'), undefined);
  assert.equal(modelPreview({ components: [...config(preview).components, ...config(preview).components] }, '角色'), undefined);
});

test('composed model previews use the head image and reject incomplete or ambiguous packages', () => {
  const head={type:'model',role:'head',name:'角色',preview};
  const body={type:'model',role:'body',name:'角色'};
  assert.equal(modelPreview({components:[body,head]},'角色'),preview);
  for (const components of [[head],[body],[head,head,body],[head,body,body]])
    assert.equal(modelPreview({components},'角色'),undefined);
});

test('hover reads after 200ms, cancelled and old requests cannot replace the current preview', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const received = [];
  let resolveOld;
  const cancelOld = scheduleModelPreview(() => { reads++; return new Promise(resolve => { resolveOld = resolve; }); }, value => received.push(value));
  t.mock.timers.tick(199);
  assert.equal(reads, 0);
  t.mock.timers.tick(1);
  assert.equal(reads, 1);
  cancelOld();
  scheduleModelPreview(async () => 'new', value => received.push(value));
  t.mock.timers.tick(200);
  await Promise.resolve();
  resolveOld('old');
  await Promise.resolve();
  assert.deepEqual(received, ['new']);
  const cancelEarly = scheduleModelPreview(async () => { reads++; }, () => {});
  cancelEarly();
  t.mock.timers.tick(200);
  assert.equal(reads, 1);
});

test('bounded preview cache shares requests and a new directory snapshot loader fetches updated image', async () => {
  let reads = 0;
  let value = preview;
  const read = async () => { reads++; return config(value); };
  const info = modelAssetMap(root, [model], true).values().next().value;
  const load = createModelPreviewLoader(read, 1);
  await Promise.all([load(info), load(info)]);
  assert.equal(reads, 1);
  await load({ ...info, configUrl: '/other/config.json' });
  await load(info);
  assert.equal(reads, 3);
  value = 'data:image/webp;base64,REVG';
  assert.equal(await createModelPreviewLoader(read)(info), value);
  assert.equal(await createModelPreviewLoader(async () => { throw new Error('missing'); })(info), undefined);
});

test('head and body previews remain separate for the same package and missing body images stay empty', async () => {
  const bodyPreview = 'data:image/webp;base64,REVG';
  const pair = { components: [
    { type: 'model', role: 'head', name: '角色', preview },
    { type: 'model', role: 'body', name: '角色', preview: bodyPreview },
  ] };
  let reads = 0;
  const load = createModelPreviewLoader(async () => { reads++; return pair; });
  const info = { name: '角色', configUrl: '/same/config.json' };
  assert.equal(await load({ ...info, role: 'head' }), preview);
  assert.equal(await load({ ...info, role: 'body' }), bodyPreview);
  assert.equal(await load({ ...info, role: 'head' }), preview);
  assert.equal(reads, 2, 'the preview cache separates roles and reuses each role independently');
  assert.equal(modelPreview({ components: [pair.components[0], { ...pair.components[1], preview: undefined }] }, '角色', 'body'), undefined);
  assert.equal(modelPreview({ components: [pair.components[0]] }, '角色', 'head'), preview);
  assert.equal(modelPreview({ components: [pair.components[1]] }, '角色', 'body'), bodyPreview);
});

async function renderModule(file, modules) {
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useContext: context => context?.value,
    useRef: value => ({ current: value }), useState: () => [undefined, () => {}], useEffect() {}, useMemo: fn => fn() };
  const { code } = await transform(await readFile(new URL(file, import.meta.url), 'utf8'), {
    loader: 'tsx', format: 'cjs', jsx: 'transform', jsxFactory: 'React.createElement',
  });
  const module = { exports: {} };
  vm.runInNewContext(code, { React, module, exports: module.exports, URL, require(name) {
    if (name === 'react') return React;
    if (name in modules) return { __esModule: true, ...modules[name] };
    if (name === '@lingui/macro') return { t: strings => strings.join('') };
    return new Proxy({ __esModule: true, default: {} }, { get: (target, key) => target[key] ?? String(key) });
  } });
  return module.exports.default;
}
function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(tree.type === type ? [tree] : []), ...(tree.children ?? []).flatMap(child => nodes(child, type))];
}

test('existing Tooltip keeps PNG preview, and model without thumbnail displays full name and description', async () => {
  const FileElement = await renderModule('../src/components/Assets/FileElement.tsx', {
    '@/utils/checkFileName': { checkFileName: () => true },
    '@/utils/getFileIcon': { extractExtension: ext => ext === 'png' ? 'image' : 'unknown', getFileIcon: () => '', getDirIcon: () => '' },
    '../../hooks/useValue': { useValue: value => ({ value, set() {} }) },
    '@/utils/gltf/modelAssets': { scheduleModelPreview },
    '@fluentui/react-icons': { bundleIcon: () => 'Icon' },
  });
  const props = { rootPath: root, type: 'list', checkHasFile: () => false, file: { name: 'image.png', path: 'figure/image.png', extName: 'png', isDir: false } };
  const png = FileElement(props);
  assert.equal(png.type, 'Tooltip');
  assert.equal(png.props.positioning, 'after-bottom');
  assert.equal(nodes(png.props.content, 'img')[0].props.src, 'games/新的 游戏/game/figure/image.png');
  const info = modelAssetMap(root, [model], true).values().next().value;
  const modelTree = FileElement({ ...props, file: { name: 'config.json', path: 'figure/分组/模型 %/config.json', extName: 'json', isDir: false }, model: info, desc: info.description });
  assert.equal(nodes(modelTree.props.content, 'img').length, 0);
  assert.ok(nodes(modelTree.props.content, 'div').some(node => node.children.includes('角色')));
  assert.ok(nodes(modelTree.props.content, 'div').some(node => node.children.includes('完整说明\n第二行')));
  const label = nodes(modelTree, 'span').find(node => node.children.includes(info.description));
  assert.equal(label.props.style.fontSize, '12px');
  assert.equal(label.props.style.textOverflow, 'ellipsis');
});

test('shared Assets hook only browses the current fixed model directory', async () => {
    const keys = [];
    const hook = await renderModule('../src/hooks/gltf/useModelAssets.ts', {
      swr: { default: key => { keys.push(key); return { data: key ? { models: [{ name: '角色', path: '分组/模型 %', description: model.description, preview }] } : undefined, mutate() {} }; } },
      '@/utils/gltf/modelAssets': { modelAssetMap, createModelPreviewLoader },
      '@/utils/gltf/ModelPreviewRoleContext': {ModelPreviewRoleContext:{value:undefined}},
    });
    const result = hook(root, [...root, '3d', 'figure']);
    assert.deepEqual([...keys[0]], ['gltf-model-directory', '新的 游戏', '', undefined]);
    assert.equal(result.models.size, 2);
    keys.length = 0;
    assert.equal(hook(root, [...root, 'background']).models.size, 0);
    assert.equal(keys[0], null);
});

test('role changes request distinct directory metadata and pass the selected role to preview loading', async () => {
  const context = { value: 'head' };
  const keys = [], reads = [], calls = [];
  const hook = await renderModule('../src/hooks/gltf/useModelAssets.ts', {
    swr: { default(key, fetcher) {
      keys.push(key); reads.push(fetcher);
      return { data: { models: [{ name: '角色', path: 'pair' }] }, mutate() {} };
    } },
    axios: { default: { async post(url, body) { calls.push({ url, body }); return { data: {} }; } } },
    '@/utils/gltf/modelAssets': { modelAssetMap, createModelPreviewLoader },
    '@/utils/gltf/ModelPreviewRoleContext': { ModelPreviewRoleContext: context },
  });
  const head = hook(root, [...root, '3d', 'figure']);
  context.value = 'body';
  const body = hook(root, [...root, '3d', 'figure']);
  assert.deepEqual([...keys[0]], ['gltf-model-directory', '新的 游戏', '', 'head']);
  assert.deepEqual([...keys[1]], ['gltf-model-directory', '新的 游戏', '', 'body']);
  assert.equal(head.models.get('3d/figure/pair').role, 'head');
  assert.equal(body.models.get('3d/figure/pair').role, 'body');
  await Promise.all(reads.map(read => read()));
  assert.deepEqual(calls.map(call => call.body.role), ['head', 'body']);
  assert.ok(calls.every(call => call.url === '/api/manageGame/browseGltfModels'));
});
