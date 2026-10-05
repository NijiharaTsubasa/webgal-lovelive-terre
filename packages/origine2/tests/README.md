# 编辑器回归测试

安装仓库依赖后，在仓库根目录执行 `yarn test`，一次运行 Terre 后端的 Jest 测试和 Origine 编辑器回归测试。

单独运行后端测试使用 `yarn test:terre --runInBand`；单独运行编辑器测试使用 `yarn test:origine`，在 `packages/origine2` 目录也可以执行 `yarn test`。测试入口会先构建编辑器预览协议包。

编辑器测试使用 Node.js 内置测试工具，自动发现本目录下的 `*.test.mjs` 文件。新增测试放入本目录即可纳入统一入口。DOM、网络及编辑器组件依赖按需使用测试替身；真实预览窗口显示效果需要单独进行浏览器验证。

后端 HTTP 端到端测试保留独立入口，在 `packages/terre2` 目录执行 `yarn test:e2e`。
