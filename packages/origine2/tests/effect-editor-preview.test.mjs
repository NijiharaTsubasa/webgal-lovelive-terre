import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { transform } from 'esbuild';

const require = createRequire(import.meta.url);
const { default: SceneParser, SCRIPT_CONFIG } = require('webgal-parser');
const parser = new SceneParser(() => {}, name => name, [], SCRIPT_CONFIG);

async function renderEditor(sentence, index) {
  const effects = [];
  const events = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
    Fragment: 'Fragment',
    memo: component => component,
    useState: initial => [initial, () => {}],
    useMemo: compute => compute(),
    useCallback: callback => callback,
    useEffect: effect => { effects.push(effect); },
  };
  const modules = {
    react: { ...React, default: React },
    'react-dom': { createPortal: child => child },
    lodash: { debounce: callback => callback },
    '@lingui/macro': { t: strings => strings.join('') },
    '@/hooks/useValue': { useValue: value => ({ value, set() {} }) },
    '@/utils/eventBus': { eventBus: { emit: (name, payload) => events.push({ name, payload }) } },
    '@/store/useEditorStore': { default: { use: {
      isUseRealtimeEffect: () => false,
      isWindowAdjustment: () => false,
      updateIsWindowAdjustment: () => () => {},
    } } },
    '@/pages/editor/GraphicalEditor/utils/useEffectEditorConfig': {
      useEffectEditorConfig: () => ({ effectConfig: {}, fieldGroups: [] }),
    },
    '@/pages/editor/GraphicalEditor/utils/effectEditorFields': {
      createEffectFieldsFromObject: value => value,
      createEffectObjectFromFields: value => value,
      mergeVisibleEffectFields: (explicit, baseline) => ({ ...baseline, ...explicit }),
    },
    '@/pages/editor/GraphicalEditor/utils/rgbToColor': { rgbToColor: () => ({}) },
    '@/pages/editor/TransformableBox/TransformableBox': { default: 'TransformableBox' },
  };
  const source = await readFile(new URL('../src/pages/editor/GraphicalEditor/components/EffectEditor.tsx', import.meta.url), 'utf8');
  const { code } = await transform(source, { loader: 'tsx', format: 'cjs', jsx: 'transform',
    jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    document: { getElementById: () => ({}) },
    require: name => {
      if (name in modules) return { __esModule: true, ...modules[name] };
      return new Proxy({ __esModule: true, default: name }, {
        get: (target, key) => target[key] ?? String(key),
      });
    },
  });
  const tree = module.exports.EffectEditor({ sentence, index, json: '', targetPath: 'game/scene/test.txt', onChange() {} });
  effects.forEach(effect => effect());
  const findBox = node => {
    if (!node || typeof node !== 'object') return undefined;
    if (node.type === 'TransformableBox') return node;
    return node.children?.map(findBox).find(Boolean);
  };
  return { events, box: findBox(tree) };
}

const scene = `changeFigure:first/config.json
  -left
  -motion=anon/bye01;
第一句;
changeFigure:CH_ruby_petitedevil01/config.json
  -motion=anon/smile01
  -expression=anon/smile01;
setTransform:{"position":{"x":100}}
  -target=fig-center;
最后一句;`;

test('effect editor previews the complete source command after folded multiline rows', async () => {
  const sentences = parser.parse(scene, 'editing', 'test.txt').sentenceList.filter(sentence => !sentence.isLineBreakHolder);
  const ruby = sentences.find(sentence => sentence.content === 'CH_ruby_petitedevil01/config.json');
  const cardIndex = sentences.indexOf(ruby) + 1;
  assert.equal(ruby.endLine + 1, 7);
  assert.notEqual(cardIndex, 7);
  const { events, box } = await renderEditor(ruby, cardIndex);
  assert.equal(events.find(event => event.name === 'editor:pixi-sync-command').payload.lineNumber, 7);
  assert.equal(box.props.sentenceInfo.lineNumber, 7);
  assert.equal(box.props.sentenceInfo.lineSentence.content, ruby.content);
});

test('transform editing also targets source lines rather than folded card positions', async () => {
  const sentences = parser.parse(scene, 'editing', 'test.txt').sentenceList.filter(sentence => !sentence.isLineBreakHolder);
  const sentence = sentences.find(item => item.commandRaw === 'setTransform');
  const { events, box } = await renderEditor(sentence, sentences.indexOf(sentence) + 1);
  assert.equal(events.find(event => event.name === 'editor:pixi-sync-command').payload.lineNumber, 9);
  assert.equal(box.props.sentenceInfo.lineNumber, 9);
});

test('single-line commands retain their preview position', async () => {
  const sentence = parser.parse('changeFigure:single/config.json;', 'editing', 'test.txt').sentenceList[0];
  const { events, box } = await renderEditor(sentence, 1);
  assert.equal(events.find(event => event.name === 'editor:pixi-sync-command').payload.lineNumber, 1);
  assert.equal(box.props.sentenceInfo.lineNumber, 1);
});
