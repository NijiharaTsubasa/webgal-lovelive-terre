import { ConsoleLogger } from '@nestjs/common';
import * as fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { GltfResourceIndexService } from './gltf-resource-index.service';
import { GltfCatalogWorkerClient } from './gltf-catalog-worker-client';
import { GltfService } from './gltf.service';
import { UserDataService } from '../user-data/user-data.service';

describe('glTF catalog push notifications', () => {
  let index: GltfResourceIndexService;
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'terre-catalog-push-'));
    jest.spyOn(UserDataService, 'getGameRoot').mockReturnValue(root);
    jest.spyOn(UserDataService, 'getEngineTemplateRoot').mockReturnValue(root);
    index = new GltfResourceIndexService(new ConsoleLogger());
  });
  afterEach(async () => {
    jest.useRealTimers();
    await index.onModuleDestroy();
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('coalesces worker changes, isolates projects and drops notifications after unsubscribe', async () => {
    jest.spyOn(GltfCatalogWorkerClient.prototype, 'start').mockImplementation(() => {});
    await index.gltfCatalogSession('demo', 'session', true);
    const client = (index as any).catalogIndexes.get('demo');
    jest.useFakeTimers();
    const changed = jest.fn(), other = jest.fn();
    const stop = index.watchGltfCatalog('demo', changed);
    const stopOther = index.watchGltfCatalog('other', other);
    for (let i = 0; i < 20; i++) client.onChange();
    await jest.advanceTimersByTimeAsync(249);
    expect(changed).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    client.onChange();
    stop(); stopOther();
    await jest.advanceTimersByTimeAsync(1000);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('publishes external motion/expression additions and deletions through the live stream', async () => {
    jest.setTimeout(20000);
    const game = join(root, 'demo');
    await fs.mkdir(join(game, 'game/3d/motion'), { recursive: true });
    await fs.mkdir(join(game, 'game/3d/mtn_exp'), { recursive: true });
    await fs.writeFile(join(game, 'index.html'), '');
    await fs.writeFile(join(game, 'webgal-engine.json'), JSON.stringify({ id: 'webgal-lovelive.lovelive' }));
    const service = new GltfService(index);
    const statuses: any[] = [];
    const received: any[] = [];
    const subscription = service.gltfCatalogSession('demo').subscribe(message => {
      if (message.type === 'catalog') {
        statuses.push(message.data);
        void index.getGltfCatalog('demo').then(snapshot => received.push(snapshot));
      }
    });
    const until = async (accept: () => boolean) => {
      const deadline = Date.now() + 9000;
      while (!accept()) {
        if (Date.now() > deadline) throw Error('Expected catalog push did not arrive');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    };
    try {
      await until(() => statuses.some(status => !status.indexing));
      const first = statuses.at(-1).revision;
      const expression = join(game, 'game/3d/mtn_exp/new.exp.json');
      const motion = join(game, 'game/3d/mtn_exp/new.mtn');
      await fs.writeFile(expression, '{"params":[]}');
      await fs.writeFile(motion, '# Live2D\n$fps=30\nPARAM_ANGLE_X=0,0');
      await until(() => received.some(snapshot => !snapshot.indexing && snapshot.revision > first &&
        ['garupa-expression', 'garupa-motion'].every(type => snapshot.resources.some(item => item.type === type))));
      let snapshot = received.at(-1);
      expect(snapshot.resources.some(item => item.type === 'garupa-expression')).toBe(true);
      expect(snapshot.resources.some(item => item.type === 'garupa-motion')).toBe(true);
      const addedRevision = snapshot.revision;
      await fs.unlink(expression); await fs.unlink(motion);
      await until(() => received.some(snapshot => !snapshot.indexing && snapshot.revision > addedRevision &&
        !snapshot.resources.some(item => ['garupa-motion', 'garupa-expression'].includes(item.type))));
      snapshot = received.at(-1);
      expect(snapshot.resources.filter(item => ['garupa-motion', 'garupa-expression'].includes(item.type))).toHaveLength(0);
    } finally { subscription.unsubscribe(); }
  }, 25000);
});
