import assert from 'node:assert/strict';
import test from 'node:test';
import { gltfFigureOptions, gltfFigureSelectionError, isGltfConfigPath, isLoveliveEngine, encodeNativeExpression, decodeNativeExpression } from '../src/utils/gltfFigure.ts';

test('only our engine enables glTF controls', () => {
  assert.equal(isLoveliveEngine({ id: 'webgal-lovelive.lovelive' }), true);
  for (const manifest of [null, {}, { id: 'webgal-mygo.mygo' }, { id: 'webgal.webgal' }]) {
    assert.equal(isLoveliveEngine(manifest), false);
  }
});

test('config paths are recognizable without scanning a resource catalog', () => {
  assert.equal(isGltfConfigPath('nested/config.json'), true);
  assert.equal(isGltfConfigPath('config.json'), true);
});

test('ordinary figure names are not mistaken for config paths', () => {
  for (const path of ['figure/Honoka.png', 'figure/anon/model.json', 'figure/spine/spine.json', 'figure/anon.wmdl', 'figure/anon.jsonl']) {
    assert.equal(isGltfConfigPath(path), false);
  }
  assert.equal(isGltfConfigPath('nested/config.json?cache=1'), true);
  assert.equal(isGltfConfigPath('nested/model.json'), false);
});

test('selection validates only component packages and reports actual resource kinds', () => {
  for (const value of [null, {}, { model: 'model.moc' }, { animations: {} }]) {
    assert.equal(gltfFigureSelectionError(value), null);
  }
  assert.equal(gltfFigureSelectionError({ components: [{ type: 'shader' }, { type: 'motion' }] }),
    '所选文件不是有效的glTF 3D模型（当前文件种类:shader、motion）');
  assert.equal(gltfFigureSelectionError({ components: [{ type: 'model', role: 'head' }] }),
    '所选文件不是有效的glTF 3D模型（当前文件种类:model（head））');
  assert.equal(gltfFigureSelectionError({ components: [] }),
    '所选文件不是有效的glTF 3D模型（当前文件种类:未声明）');
  const model = { type: 'model', role: 'integrated', model: 'model.glb' };
  assert.equal(gltfFigureSelectionError({ components: [model, { type: 'shader' }] }), null);
  assert.equal(gltfFigureSelectionError({ components: [model, model] }), '暂不支持一个配置包含多个glTF 3D模型');
});

test('only one integrated model can supply model-owned expressions', () => {
  const integrated = { type: 'model', role: 'integrated', model: 'model.glb', expressionGroups: [{ type: 'eye', states: [{ name: 'Sad' }, { name: 'Neutral' }] }] };
  assert.equal(gltfFigureOptions({ components: [{ type: 'shader' }] }, []), null);
  assert.equal(gltfFigureOptions({ components: [{ ...integrated, role: 'head' }] }, []), null);
  assert.equal(gltfFigureOptions({ components: [integrated, integrated] }, []), null);
  assert.deepEqual(gltfFigureOptions({ components: [integrated] }, []), { motions: [], expressions: [], nativeExpressions: { eyes: ['Sad', 'Neutral'], mouths: [], defaults: { eye: 'Sad' } }, supportsLive2DExpressions: false });
});

test('parameter expressions are separate from native choices and deduplicate', () => {
  assert.deepEqual(gltfFigureOptions({ components: [{ type: 'model', role: 'integrated', model: 'model.glb', motionGroup: 'llas', expressionGroups: [{ type: 'mouth', states: [{ name: 'Smile' }, { name: 'A' }] }], defaultExpression: { closed: 'Smile', open: 'A' } }] }, [
    { type: 'motion', name: 'mot_00_00010', config: 'motion/config.json' },
    { type: 'garupa-motion', name: 'anon/angry01', config: 'garupa/config.json' },
    { type: 'garupa-expression', name: 'anon/sad01', config: 'garupa/config.json' },
    { type: 'shader', name: 'toon', config: 'deps/config.json' },
    { type: 'garupa-expression-adapter', name: 'llas', config: 'deps/config.json' },
  ], [{ components: [{ type: 'garupa-expression-adapter', motionGroup: 'llas' }] }]), { motions: ['anon/angry01', 'mot_00_00010'], expressions: ['anon/sad01'], nativeExpressions: { eyes: [], mouths: ['Smile', 'A'], defaults: { closed: 'Smile', open: 'A' } }, supportsLive2DExpressions: true });
});

test('models without a matching adapter hide parameter expressions but keep native choices and parameter motions', () => {
  const resources = [
    { type: 'garupa-expression', name: 'anon/sad01', config: 'garupa/config.json' },
    { type: 'garupa-motion', name: 'anon/angry01', config: 'garupa/config.json' },
  ];
  for (const motionGroup of ['hasunosora', undefined]) {
    const options = gltfFigureOptions({ components: [{ type: 'model', role: 'integrated', model: 'model.glb', motionGroup, expressionGroups: [{ type: 'eye', states: [{ name: 'Sad' }] }] }] }, resources,
      [{ components: [{ type: 'garupa-expression-adapter', name: 'hasunosora', motionGroup: 'llas' }] }]);
    assert.deepEqual(options.expressions, []);
    assert.deepEqual(options.nativeExpressions.eyes, ['Sad']);
    assert.equal(options.supportsLive2DExpressions, false);
    assert.deepEqual(options.motions, ['anon/angry01']);
  }
});

test('native combination encoding preserves separator-bearing names and absent slots', () => {
  const selection = { eye: 'wink/左', closed: 'Smile %', open: 'A/#?' };
  assert.deepEqual(decodeNativeExpression(encodeNativeExpression(selection)), selection);
  assert.equal(encodeNativeExpression({ eye: 'Open' }), '3d:Open//');
  assert.deepEqual(decodeNativeExpression('3d:Open//'), { eye: 'Open' });
  for (const value of ['anon/angry', '3d:x/y', '3d:%/a/b']) assert.equal(decodeNativeExpression(value), null);
});
