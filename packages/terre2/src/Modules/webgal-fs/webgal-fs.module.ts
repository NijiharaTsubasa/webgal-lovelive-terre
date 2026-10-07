import { ConsoleLogger, Module } from '@nestjs/common';
import { GltfModule } from '../gltf/gltf.module';
import { WebgalFsService } from './webgal-fs.service';

@Module({
  imports: [GltfModule],
  providers: [WebgalFsService, ConsoleLogger],
  exports: [WebgalFsService, ConsoleLogger],
})
export class WebgalFsModule {}
