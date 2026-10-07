import { ConsoleLogger, Module } from '@nestjs/common';
import { GltfController } from './gltf.controller';
import { GltfService } from './gltf.service';
import { GltfResourceIndexService } from './gltf-resource-index.service';

@Module({
  providers: [ConsoleLogger, GltfService, GltfResourceIndexService],
  controllers: [GltfController],
  exports: [GltfResourceIndexService],
})
export class GltfModule {}
