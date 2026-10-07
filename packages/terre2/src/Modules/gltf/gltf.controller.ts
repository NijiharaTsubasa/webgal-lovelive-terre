import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GltfService } from './gltf.service';

@Controller('api/manageGame')
@ApiTags('Manage Game')
export class GltfController {
  constructor(private readonly gltf: GltfService) {}

  @Post('updateGltfResourceCatalog')
  async updateGltfResourceCatalog(@Body() data: { gameName: string; revision?: number }) {
    return this.gltf.updateGltfResourceCatalog(data.gameName, data.revision);
  }

  @Post('gltfCatalogSession')
  async gltfCatalogSession(@Body() data: { gameName: string; sessionId: string; active: boolean }) {
    return this.gltf.gltfCatalogSession(data.gameName, data.sessionId, data.active);
  }

  @Post('browseGltfModels')
  async browseGltfModels(@Body() data: { gameName: string; directory: string }) {
    return this.gltf.browseGltfModels(data.gameName, data.directory);
  }

  @Post('selectGltfModel')
  async selectGltfModel(@Body() data: { gameName: string; path: string }) {
    return this.gltf.selectGltfModel(data.gameName, data.path);
  }

}
