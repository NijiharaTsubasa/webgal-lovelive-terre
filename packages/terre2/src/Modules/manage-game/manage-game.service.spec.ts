import { Test, TestingModule } from '@nestjs/testing';
import { ConsoleLogger } from '@nestjs/common';
import { ManageGameService } from './manage-game.service';
import { WebgalFsService } from '../webgal-fs/webgal-fs.service';

jest.mock('trash', () => ({ __esModule: true, default: jest.fn() }));

describe('ManageGameService', () => {
  let service: ManageGameService;
  const catalog = { enabled: true, resources: [{ type: 'motion', name: 'idle' }], issues: [], revision: 4, indexing: false };
  const filesystem = { getGltfCatalog: jest.fn(), gltfCatalogSession: jest.fn() };

  beforeEach(async () => {
    filesystem.getGltfCatalog.mockReset().mockResolvedValue(catalog);
    filesystem.gltfCatalogSession.mockReset().mockResolvedValue({ ok: true });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ManageGameService,
        {
          provide: ConsoleLogger,
          useValue: { log: jest.fn(), error: jest.fn() },
        },
        { provide: WebgalFsService, useValue: filesystem },
      ],
    }).compile();

    service = module.get<ManageGameService>(ManageGameService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('returns only status for an unchanged revision and a complete snapshot otherwise', async () => {
    expect(await service.updateGltfResourceCatalog('demo', false, 4)).toEqual({ enabled: true, revision: 4, indexing: false, unchanged: true });
    expect(await service.updateGltfResourceCatalog('demo', false, 3)).toEqual(catalog);
  });

  it('rejects malformed sessions and forwards valid editor leases', async () => {
    await expect(service.gltfCatalogSession('../demo', 'tab', true)).rejects.toThrow('Invalid catalog session');
    await expect(service.gltfCatalogSession('demo', '', true)).rejects.toThrow('Invalid catalog session');
    expect(await service.gltfCatalogSession('demo', 'tab', false)).toEqual({ ok: true });
    expect(filesystem.gltfCatalogSession).toHaveBeenCalledWith('demo', 'tab', false);
  });
});
