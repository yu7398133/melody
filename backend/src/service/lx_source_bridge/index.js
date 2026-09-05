const logger = require('consola');
const fs = require('fs');
const path = require('path');
const { loadAllSources, loadSource, clearCache } = require('./source_loader');

const CONFIG_PATH = path.join(__dirname, 'config.json');

// Source code mapping: media-get source -> LX Music source code
const SOURCE_MAP = {
  'kuwo': 'kw',
  'netease': 'wy',
  'qq': 'tx',
  'kugou': 'kg',
  'migu': 'mg',
};

// Reverse mapping: LX Music source code -> media-get source
const REVERSE_SOURCE_MAP = {
  'kw': 'kuwo',
  'wy': 'netease',
  'tx': 'qq',
  'kg': 'kugou',
  'mg': 'migu',
};

// Extract songmid from a media-get search result URL
function extractSongmid(source, url) {
  if (!url) return null;
  
  switch (source) {
    case 'kuwo': {
      // https://www.kuwo.cn/play_detail/228908
      const m = url.match(/play_detail\/(\d+)/);
      return m ? m[1] : null;
    }
    case 'netease': {
      // https://music.163.com/#/song?id=2652820720
      const m = url.match(/[?&]id=(\d+)/);
      return m ? m[1] : null;
    }
    case 'qq': {
      // https://y.qq.com/n/ryqq/songDetail/004OmEt53sLWcn
      const m = url.match(/songDetail\/([A-Za-z0-9]+)/);
      return m ? m[1] : null;
    }
    case 'kugou': {
      // https://www.kugou.com/song/#hash=xxx
      const m = url.match(/hash=([A-Za-z0-9]+)/);
      return m ? m[1] : null;
    }
    case 'migu': {
      const m = url.match(/song\/([A-Za-z0-9]+)/) || url.match(/id=([A-Za-z0-9]+)/);
      return m ? m[1] : null;
    }
    default:
      return null;
  }
}

// State
let loadedSources = [];
let initialized = false;

// Initialize all enabled LX sources
async function init() {
  if (initialized) return;
  initialized = true;
  
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!config.globalEnabled) {
      logger.info('[lx-bridge] LX source bridge is disabled in config');
      return;
    }
    
    logger.info('[lx-bridge] initializing LX source bridge...');
    loadedSources = await loadAllSources(CONFIG_PATH);
    logger.info('[lx-bridge] loaded ' + loadedSources.length + ' LX sources');
    
    for (const s of loadedSources) {
      const sourceInfo = s.sources || {};
      const platforms = Object.keys(sourceInfo);
      logger.info('[lx-bridge] source ' + (s.config.name) + ' supports: ' + JSON.stringify(platforms));
    }
  } catch (e) {
    logger.error('[lx-bridge] init error: ' + e.message);
    loadedSources = [];
  }
}

// Find a loaded LX source that supports the given platform
function findSourceForPlatform(lxSourceCode) {
  for (const s of loadedSources) {
    const sources = s.sources || {};
    if (sources[lxSourceCode]) {
      return s;
    }
  }
  return null;
}

// Resolve music URL from a media-get search result
async function resolveUrlFromSearchResult(searchItem) {
  await init();
  
  if (loadedSources.length === 0) {
    return null;
  }
  
  const mediaGetSource = searchItem.source;
  const lxSourceCode = SOURCE_MAP[mediaGetSource];
  
  if (!lxSourceCode) {
    logger.info('[lx-bridge] no LX source mapping for: ' + mediaGetSource);
    return null;
  }
  
  const lxSource = findSourceForPlatform(lxSourceCode);
  if (!lxSource) {
    logger.info('[lx-bridge] no loaded LX source supports: ' + lxSourceCode);
    return null;
  }
  
  const songmid = extractSongmid(mediaGetSource, searchItem.url);
  if (!songmid) {
    logger.warn('[lx-bridge] could not extract songmid from: ' + searchItem.url);
    return null;
  }
  
  // Build musicInfo for the LX source
  const musicInfo = {
    songmid: songmid,
    songId: songmid,
    hash: songmid,
    songName: searchItem.songName,
    singer: searchItem.artist,
    albumName: searchItem.album,
  };
  
  // Get the best available quality
  const sourceConfig = lxSource.sources[lxSourceCode];
  const availableQualities = sourceConfig.qualitys || sourceConfig.qualities || ['128k'];
  const quality = Array.isArray(availableQualities) ? availableQualities[0] : availableQualities.split('|')[0];
  
  logger.info('[lx-bridge] resolving URL: source=' + lxSourceCode + ', songmid=' + songmid + ', quality=' + quality);
  
  try {
    const url = await lxSource.runtime.resolveMusicUrl(lxSourceCode, musicInfo, quality);
    if (url) {
      logger.info('[lx-bridge] resolved URL: ' + (typeof url === 'string' ? url.slice(0, 80) + '...' : JSON.stringify(url).slice(0, 200)));
      return typeof url === 'string' ? url : (url && url.url) ? url.url : null;
    }
  } catch (e) {
    logger.error('[lx-bridge] resolveMusicUrl error: ' + e.message);
  }
  
  return null;
}

// Get all available sources and their capabilities
async function getAvailableSources() {
  await init();
  const result = [];
  for (const s of loadedSources) {
    const sources = s.sources || {};
    for (const [code, info] of Object.entries(s.sources || {})) {
      const mediaGetSource = REVERSE_SOURCE_MAP[code];
      if (mediaGetSource) {
        result.push({
          lxSource: code,
          mediaGetSource: mediaGetSource,
          name: s.config.name,
          label: s.config.label,
          qualities: info.qualitys || info.qualities || [],
          actions: info.actions || [],
        });
      }
    }
  }
  return result;
}

// Reload sources (clear cache and reinit)
async function reload() {
  clearCache();
  initialized = false;
  loadedSources = [];
  await init();
  return { loaded: loadedSources.length };
}

module.exports = {
  init,
  resolveUrlFromSearchResult,
  getAvailableSources,
  reload,
  extractSongmid,
  SOURCE_MAP,
  REVERSE_SOURCE_MAP,
};

