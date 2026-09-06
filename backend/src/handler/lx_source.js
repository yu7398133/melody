const lxSourceBridge = require('../service/lx_source_bridge');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'service', 'lx_source_bridge', 'config.json');

async function getStatus(req, res) {
  await lxSourceBridge.init();
  const sources = await lxSourceBridge.getAvailableSources();
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  
  res.json({
    globalEnabled: config.globalEnabled,
    availableSources: sources,
    configuredSources: config.sources.map(s => ({
      name: s.name,
      label: s.label,
      enabled: s.enabled,
      url: s.url || null,
      file: s.file || null,
      platforms: s.platforms || [],
      qualities: s.qualities || [],
      priority: s.priority || 99,
    })),
  });
}

async function reload(req, res) {
  const result = await lxSourceBridge.reload();
  const sources = await lxSourceBridge.getAvailableSources();
  res.json({ 
    success: true, 
    loaded: result.loaded,
    availableSources: sources,
  });
}

async function resolveUrl(req, res) {
  const { source, url, songName, artist } = req.body;
  
  if (!source || !url) {
    return res.status(400).json({ error: 'source and url are required' });
  }
  
  const resolved = await lxSourceBridge.resolveUrlFromSearchResult({
    source,
    url,
    songName: songName || '',
    artist: artist || '',
  });
  
  res.json({
    success: !!resolved,
    originalUrl: url,
    resolvedUrl: resolved,
  });
}


// ---- check API: 检测某首歌能否用 LX 源解析（带缓存 + 串行节流，防触发音源API封禁） ----
const checkCache = new Map(); // key: source:songmid -> {time, canResolve}
const CACHE_TTL = 10 * 60 * 1000; // 10 分钟
const MIN_INTERVAL = 600; // 相邻请求最小间隔 ms
let checkQueue = Promise.resolve();

async function checkUrl(req, res) {
  const { source, url } = req.query;
  if (!source || !url) {
    return res.status(400).json({ status: 1, message: 'source and url are required' });
  }

  const code = lxSourceBridge.SOURCE_MAP[source];
  if (!code) {
    return res.json({ status: 0, data: { canResolve: false, reason: 'platform-not-supported' } });
  }

  const songmid = lxSourceBridge.extractSongmid(source, url);
  if (!songmid) {
    return res.json({ status: 0, data: { canResolve: false, reason: 'no-songmid' } });
  }

  const cacheKey = code + ':' + songmid;
  const cached = checkCache.get(cacheKey);
  if (cached && (Date.now() - cached.time < CACHE_TTL)) {
    return res.json({ status: 0, data: { canResolve: cached.canResolve, cached: true } });
  }

  // 串行队列：等前一个完成后再隔 MIN_INTERVAL 发起
  const task = checkQueue.then(async () => {
    await new Promise(r => setTimeout(r, MIN_INTERVAL));
    try {
      await lxSourceBridge.init();
      const resolved = await lxSourceBridge.resolveUrlFromSearchResult({
        source: source,
        url: url,
        songName: '',
        artist: '',
      });
      const ok = !!resolved;
      checkCache.set(cacheKey, { time: Date.now(), canResolve: ok });
      return ok;
    } catch (e) {
      checkCache.set(cacheKey, { time: Date.now(), canResolve: false });
      return false;
    }
  });
  checkQueue = task.catch(() => {});

  const canResolve = await task;
  res.json({ status: 0, data: { canResolve: canResolve } });
}

module.exports = {
  getStatus,
  reload,
  resolveUrl,
  checkUrl,
};

