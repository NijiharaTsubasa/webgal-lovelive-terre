import assert from 'node:assert/strict';
import test from 'node:test';
import { preferredExpressionMode, preferredFigure3D, rememberExpressionMode, rememberFigureMode } from '../src/utils/gltfFigure.ts';

test('picker preferences are used only for empty values; capability fallback does not change memory', () => {
  assert.equal(preferredFigure3D(''), false);
  assert.equal(preferredExpressionMode('', true, ['anon/sad01']), 'live2d');
  rememberFigureMode(true);
  assert.equal(preferredFigure3D(''), true);
  assert.equal(preferredFigure3D('none'), true);
  assert.equal(preferredFigure3D('anon/model.json'), false);
  rememberFigureMode(false);
  assert.equal(preferredFigure3D('3d/figure/ruby/config.json'), true);
  assert.equal(preferredFigure3D(''), false);
  rememberExpressionMode('3d');
  assert.equal(preferredExpressionMode('', true, ['anon/sad01']), '3d');
  assert.equal(preferredExpressionMode('anon/sad01', true, ['anon/sad01']), 'live2d');
  rememberExpressionMode('live2d');
  assert.equal(preferredExpressionMode('3d:Sad/Smile/A', true, ['anon/sad01']), '3d');
  assert.equal(preferredExpressionMode('', false, []), '3d');
  assert.equal(preferredExpressionMode('', true, []), '3d');
  assert.equal(preferredExpressionMode('', true, ['anon/sad01']), 'live2d');
});
