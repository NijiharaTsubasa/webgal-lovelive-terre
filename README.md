# WebGAL_LoveLive专版可视化编辑器

本项目 Fork 自 [WebGAL_MYGO专版可视化编辑器](https://github.com/boomwwww/webgal-mygo-terre/)

仅对原 WebGAL_MYGO_Terre 编辑器做适配 3D 立绘的最小化修改，3D 模型复用 Live2D 编辑界面和参数。

## 必看：如何让 3D 立绘加载 BanG Dream Live2D 表情和动作

默认情况下，3D 立绘不会加载 BanG Dream Live2D 表情和动作，原因是 Live2D 表情和动作和模型绑定，figure 目录中可能有多套重复的表情和动作。为了避免冲突，需要手动指定目录加载供 3D 立绘使用的 Live2D 表情和动作。

1、首先在 `figure` 目录下创建一个新目录，名称任意，例如 `bangdream_live2d` ，后续 3D 立绘会从此目录读取表情和动作。

2、找到已有的 BanG Dream Live2D 表情和动作，一般位于 `figure/任意mygo_mujica角色/.mtn_exp/expressions/__base__/` 和 `figure/任意mygo_mujica角色/.mtn_exp/motions/PARAM_IMPORT__数字/` 这两个路径，将其中的全部角色名文件夹复制到上一步新建的目录。同名角色文件夹请合并，保留其中的动作和表情文件。

若看不到 `.mtn_exp` 目录，请在文件夹选项中打开“显示隐藏的文件、文件夹和驱动器”。

复制好后目录结构应该如下所示：
```
bangdream_live2d
|- anon
    |- angry01.mtn
    |- angry01.exp.json
    |- ...
|- mana
|- ...
```

3、在第一步创建的目录中新建 `config.json` 文件，原样复制并保存以下内容：
```json
{"components":[]}
```

4、使用 WebGAL LoveLive Terre 打开一次工程，会自动搜索该目录中的表情和动作，并在 3D 立绘的对应下拉框中显示。

后续增加表情或动作只需复制到此目录，删除表情或动作只需直接删除，界面中的列表会自动刷新。

## 生成式人工智能使用声明

本项目中大部分新增代码均由生成式人工智能（Generative AI）工具协助编写。核心路线和方案由作者与 AI 共同讨论确定。

但由于作者本人对该领域技术栈不熟悉，未对代码进行深度的代码审查或系统的测试，主要对最终呈现的功能效果进行验收，因此代码库可能存在较多技术债务与不规范之处。

如您在使用中遇到问题，或愿意帮助优化、重构底层代码，欢迎通过 Issue 或 Pull Request 参与共建。

---

以下为原仓库README.md文件

---

![WebGAL Terre Slogan CN](https://github.com/OpenWebGAL/WebGAL_Terre/assets/30483415/69919753-9068-4465-8b11-a0de89b5a244)


<a href="https://www.producthunt.com/posts/webgal?utm_source=badge-featured&utm_medium=badge&utm_souce=badge-webgal" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=443280&theme=light" alt="WebGAL - Galgame&#0032;Editing&#0046;&#0032;Redefined | Product Hunt" style="width: 250px; height: 54px;" width="250" height="54" /></a>

### [English](README_EN.md) | [日本語](README_JP.md)

## 这是 WebGAL 可视化编辑器项目。如果你想要查看 WebGAL 的源代码，请前往 [WebGAL代码仓库](https://github.com/OpenWebGAL/WebGAL)

# WebGAL_Terre

**重新定义Galgame的制作方式**

以最快捷的方式创建属于你自己的 Galgame，并支持导出为网页和 Windows 可执行文件。

方便地上传、管理和预览你的游戏素材。

多标签页的编辑器，可以让你快速在多个剧本间切换。

## 立即体验

##### 下载链接

https://github.com/OpenWebGAL/WebGAL_Terre/releases

## 使用说明

https://docs.openwebgal.com/

## 参与贡献

[WebGAL Terre 贡献指南](https://docs.openwebgal.com/developers/terre.html)

### 赞助

WebGAL 是一款开源软件，因此你可以免费在 MPL-2.0 开源协议的范畴下使用本软件，并可用于商业使用。

但即便如此，你的赞助也可以给予开发者前进的动力，让这个项目变得更好。

[赞助本项目](https://docs.openwebgal.com/sponsor/)


# Sponsors

<a href="https://openwebgal.com/">
<img alt="Sponsor" src="https://raw.githubusercontent.com/OpenWebGAL/static/main/sponsors.png">
</a>
