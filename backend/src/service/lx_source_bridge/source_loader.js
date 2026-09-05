const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const logger = require('consola');
const { createLxRuntime } = require('./runtime');

// Cache for loaded sources
const sourceCache = {};

// Download a script from URL
function downloadScript(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https://') ? https : http;
    const req = lib.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        downloadScript(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        return;
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Load a source script and create runtime
async function loadSource(sourceConfig) {
  const cacheKey = sourceConfig.name || sourceConfig.url;
  
  if (sourceCache[cacheKey]) {
    logger.info('[lx-loader] using cached source: ' + cacheKey);
    return sourceCache[cacheKey];
  }

  let scriptCode = '';
  
  // Load from URL or local file
  if (sourceConfig.url) {
    logger.info('[lx-loader] downloading source from: ' + sourceConfig.url);
    scriptCode = await downloadScript(sourceConfig.url);
  } else if (sourceConfig.file) {
    logger.info('[lx-loader] loading source from file: ' + sourceConfig.file);
    scriptCode = fs.readFileSync(sourceConfig.file, 'utf8');
  } else {
    throw new Error('source config needs url or file');
  }

  // Extract version from script header
  const versionMatch = scriptCode.match(/@version\s+(.+)/);
  const scriptVersion = versionMatch ? versionMatch[1].trim() : '1';

  logger.info('[lx-loader] script version: ' + scriptVersion + ', size: ' + scriptCode.length);

  // Create runtime
  const runtime = createLxRuntime(scriptCode, scriptVersion);
  
  // Wait for initialization
  await runtime.waitForInit(sourceConfig.initTimeout || 15000);
  
  const sources = runtime.getSources();
  logger.info('[lx-loader] source ' + cacheKey + ' initialized, sources: ' + JSON.stringify(sources));

  sourceCache[cacheKey] = { runtime, config: sourceConfig, sources };
  return sourceCache[cacheKey];
}

// Load all sources from config
async function loadAllSources(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const results = [];
  
  for (const sourceConfig of config.sources) {
    if (!sourceConfig.enabled) {
      logger.info('[lx-loader] skipping disabled source: ' + (sourceConfig.name || sourceConfig.url));
      continue;
    }
    try {
      const loaded = await loadSource(sourceConfig);
      results.push(loaded);
    } catch (e) {
      logger.error('[lx-loader] failed to load source ' + (sourceConfig.name || sourceConfig.url) + ': ' + e.message);
    }
  }
  
  return results;
}

// Clear cache (for reloading)
function clearCache() {
  Object.keys(sourceCache).forEach(key => delete sourceCache[key]);
}

module.exports = {
  loadSource,
  loadAllSources,
  downloadScript,
  clearCache,
};

