import { Body, Controller, Post, Query, Sse } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GltfService } from './gltf.service';
import type { GltfModelRole } from './gltf-model-packages';

@Controller('api/manageGame')
@ApiTags('Manage Game')
export class GltfController {
  constructor(private readonly gltf: GltfService) {}

  @Post('updateGltfResourceCatalog')
  async updateGltfResourceCatalog(@Body() data: { gameName: string; revision?: number }) {
    return this.gltf.updateGltfResourceCatalog(data.gameName, data.revision);
  }

  @Sse('gltfCatalogSession')
  gltfCatalogSession(@Query('gameName') gameName: string) {
    return this.gltf.gltfCatalogSession(gameName);
  }

  @Post('browseGltfModels')
  async browseGltfModels(@Body() data: { gameName: string; directory: string; role?: GltfModelRole }) {
    return this.gltf.browseGltfModels(data.gameName, data.directory, data.role);
  }

  @Post('selectGltfModel')
  async selectGltfModel(@Body() data: { gameName: string; path: string; role?: GltfModelRole }) {
    return this.gltf.selectGltfModel(data.gameName, data.path, data.role);
  }

}
