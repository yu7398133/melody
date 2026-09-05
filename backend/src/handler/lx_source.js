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

module.exports = {
  getStatus,
  reload,
  resolveUrl,
};

