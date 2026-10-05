import assert from 'node:assert/strict';
import test from 'node:test';
import { gltfFigureOptions, gltfFigureSelectionError, isGltfConfigPath, isLoveliveEngine } from '../src/utils/gltfFigure.ts';

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
  const integrated = { type: 'model', role: 'integrated', model: 'model.glb', expressions: [{ name: 'Sad' }, { name: 'Neutral' }] };
  assert.equal(gltfFigureOptions({ components: [{ type: 'shader' }] }, []), null);
  assert.equal(gltfFigureOptions({ components: [{ ...integrated, role: 'head' }] }, []), null);
  assert.equal(gltfFigureOptions({ components: [integrated, integrated] }, []), null);
  assert.deepEqual(gltfFigureOptions({ components: [integrated] }, []), { motions: [], expressions: ['Neutral', 'Sad'], supportsLive2DExpressions: false });
});

test('shared motion and supported parameter expression names merge with presets and deduplicate', () => {
  assert.deepEqual(gltfFigureOptions({ components: [{ type: 'model', role: 'integrated', model: 'model.glb', motionGroup: 'llas', expressions: [{ name: 'Smile' }, { name: 'Smile' }] }] }, [
    { type: 'motion', name: 'mot_00_00010', config: 'motion/config.json' },
    { type: 'garupa-motion', name: 'anon/angry01', config: 'garupa/config.json' },
    { type: 'garupa-expression', name: 'anon/sad01', config: 'garupa/config.json' },
    { type: 'shader', name: 'toon', config: 'deps/config.json' },
    { type: 'garupa-expression-adapter', name: 'llas', config: 'deps/config.json' },
  ], [{ components: [{ type: 'garupa-expression-adapter', motionGroup: 'llas' }] }]), { motions: ['anon/angry01', 'mot_00_00010'], expressions: ['anon/sad01', 'Smile'], supportsLive2DExpressions: true });
});

test('models without a matching adapter hide parameter expressions but keep presets and parameter motions', () => {
  const resources = [
    { type: 'garupa-expression', name: 'anon/sad01', config: 'garupa/config.json' },
    { type: 'garupa-motion', name: 'anon/angry01', config: 'garupa/config.json' },
  ];
  for (const motionGroup of ['hasunosora', undefined]) {
    const options = gltfFigureOptions({ components: [{ type: 'model', role: 'integrated', model: 'model.glb', motionGroup, expressions: [{ name: 'Sad' }] }] }, resources,
      [{ components: [{ type: 'garupa-expression-adapter', name: 'hasunosora', motionGroup: 'llas' }] }]);
    assert.deepEqual(options.expressions, ['Sad']);
    assert.equal(options.supportsLive2DExpressions, false);
    assert.deepEqual(options.motions, ['anon/angry01']);
  }
});
