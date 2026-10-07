import { Test } from '@nestjs/testing';
import { GltfModule } from './gltf.module';
import { GltfService } from './gltf.service';
import { GltfResourceIndexService } from './gltf-resource-index.service';
import { WebgalFsModule } from '../webgal-fs/webgal-fs.module';
import { WebgalFsService } from '../webgal-fs/webgal-fs.service';
import { ManageGameModule } from '../manage-game/manage-game.module';
import { ManageGameService } from '../manage-game/manage-game.service';

jest.mock('trash', () => ({ __esModule: true, default: jest.fn() }));

describe('glTF module integration', () => {
  it('compiles the HTTP, filesystem and game modules with one shared index', async () => {
    const module = await Test.createTestingModule({
      imports: [GltfModule, WebgalFsModule, ManageGameModule],
    }).compile();
    try {
      const index = module.get(GltfResourceIndexService);
      expect(module.get(GltfService)).toBeDefined();
      expect((module.get(GltfService) as any).index).toBe(index);
      expect((module.get(WebgalFsService) as any).gltfIndex).toBe(index);
      expect((module.get(ManageGameService) as any).gltfIndex).toBe(index);
    } finally {
      await module.close();
    }
  });
});
