import { GltfModule } from '../gltf/gltf.module';
import { Module } from '@nestjs/common';
import { ManageGameService } from './manage-game.service';
import { WebgalFsModule } from '../webgal-fs/webgal-fs.module';
import { ManageGameController } from './manage-game.controller';

@Module({
  imports: [WebgalFsModule, GltfModule],
  providers: [ManageGameService],
  controllers: [ManageGameController],
})
export class ManageGameModule {}
