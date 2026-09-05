# LX Source Bridge - LX 音乐源桥接模块

## 功能介绍

在 Melody 后端中集成了 LX Music Desktop 自定义音源的运行时，使 Melody 可以加载和执行任何符合 LX Music 自定义源协议的 JavaScript 脚本（如野草源、六音源等），从而扩充歌曲搜索和下载的音源覆盖范围。

## 架构

```
melody 后端
├── src/service/
│   ├── media_fetcher/           # 原有：media-get 搜索+下载
│   │   └── index.js             # 修改：集成 LX 桥接，下载时优先尝试 LX 源
│   ├── search_songs/            # 原有：匹配逻辑（不修改）
│   ├── sync_music/              # 修改：解锁流程优先用 LX 源 URL
│   │   ├── unblock_music_in_playlist.js
│   │   └── unblock_music_with_song_id.js
│   └── lx_source_bridge/        # 🆕 新增：LX 音源桥接
│       ├── runtime.js           # LX Music 自定义源运行时（VM 沙箱）
│       ├── source_loader.js     # 源脚本加载器
│       ├── index.js             # 桥接入口
│       └── config.json          # 源配置
├── src/handler/
│   └── lx_source.js             # 🆕 LX 源管理 API handler
└── src/router.js                # 修改：添加 LX 源路由
```

## 工作流程

1. **搜索**：用户触发解锁 VIP 歌曲 → media-get 跨平台搜索（不阻塞）
2. **匹配**：找到最佳匹配结果（含酷我等平台的 songmid）
3. **LX 源解析**：桥接模块加载 LX Music 自定义源脚本 → 提取 songmid → 调用源 API 获取直链
4. **下载**：优先用 LX 源解析的直链下载；失败则回退到 media-get 原始 URL
5. **上传**：下载成功后上传到网易云盘

## 已支持源

| 源 | 平台 | 音质 | 状态 |
|---|---|---|---|
| 野草源 (yc.js) | 酷我 (kw) | 128k | API 不稳定 |
| Grass源 (grass.js) | 酷我 (kw) | 128k | 可加载，API 需验证 |

## 添加新源

1. 将源脚本文件放到 `profile/lx-sources/` 目录（bind mount 持久化）
2. 修改 `config.json` 添加源配置：
   ```json
   {
     "name": "新源名",
     "label": "显示名",
     "file": "/app/backend/.profile/lx-sources/new-source.js",
     "enabled": true,
     "initTimeout": 15000,
     "platforms": [],
     "qualities": [],
     "priority": 5
   }
   ```
3. 调用 `POST /api/lx-source/reload` 或重启容器

## API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/lx-source/status | 查看所有 LX 源状态 |
| POST | /api/lx-source/reload | 重新加载所有源 |
| POST | /api/lx-source/resolve | 测试解析某首歌的 URL |

## 技术细节

- **运行时**：使用 Node.js `vm` 模块创建沙箱，模拟 LX Music Desktop 的 `globalThis.lx` API
- **songmid 提取**：从 media-get 搜索结果 URL 中提取各平台歌曲 ID
  - 酷我：`https://www.kuwo.cn/play_detail/{songmid}`
  - 网易云：`https://music.163.com/#/song?id={songmid}`
  - QQ：`https://y.qq.com/n/ryqq/songDetail/{songmid}`
- **源码映射**：media-get 源 ↔ LX Music 源码
  - kuwo → kw, netease → wy, qq → tx, kugou → kg, migu → mg
- **错误处理**：LX 源失败自动回退到 media-get，不影响原有功能

