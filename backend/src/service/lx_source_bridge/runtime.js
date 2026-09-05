const vm = require('vm');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const logger = require('consola');

// LX Music event names - must match LX Music Desktop's actual EVENT_NAMES
const EVENT_NAMES = {
  inited: 'inited',
  requestMusicUrl: 'musicUrl',
  requestSearch: 'search',
  updateAlert: 'updateAlert',
  requestMusicInfo: 'musicInfo',
  requestLyric: 'lyric',
  requestPic: 'pic',
  setMusicInfo: 'setMusicInfo',
};

// Make an HTTP request (supports both http and https)
function httpRequest(url, options, callback) {
  const method = (options && options.method) || 'GET';
  const headers = (options && options.headers) || {};
  const isHttps = url.startsWith('https://');
  const lib = isHttps ? https : http;

  const reqOptions = { method, headers, timeout: 15000 };
  
  try {
    const parsedUrl = new URL(url);
    reqOptions.hostname = parsedUrl.hostname;
    reqOptions.port = parsedUrl.port || (isHttps ? 443 : 80);
    reqOptions.path = parsedUrl.pathname + parsedUrl.search;
  } catch(e) {
    // URL parsing failed, use raw
  }

  const req = lib.request(reqOptions, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        callback(null, { statusCode: res.statusCode, body: body, headers: res.headers });
      } catch(callbackErr) {
        logger.error('[lx-runtime] request callback error: ' + callbackErr.message);
      }
    });
  });
  req.on('error', (err) => {
    try {
      callback(err, null);
    } catch(e) {
      logger.error('[lx-runtime] request error callback failed: ' + e.message);
    }
  });
  req.on('timeout', () => {
    req.destroy();
    try {
      callback(new Error('request timeout'), null);
    } catch(e) {
      logger.error('[lx-runtime] timeout callback failed: ' + e.message);
    }
  });
  req.end();
  return { abort: () => { req.destroy(); } };
}

// MD5 hash
function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// Buffer utilities
function bufFrom(str, encoding) {
  return Buffer.from(str, encoding || 'utf8');
}
function bufAlloc(size) {
  return Buffer.alloc(size);
}
function bufToString(buf, type) {
  if (type === 'hex') return buf.toString('hex');
  if (type === 'base64') return buf.toString('base64');
  return buf.toString('utf8');
}

// Create the LX runtime context for a given source script
function createLxRuntime(scriptCode, scriptVersion) {
  const eventHandlers = {};
  let initComplete = false;
  let initSent = false;
  const runtime = {
    sources: {},
    musicUrlHandler: null,
    searchHandler: null,
  };

  const lxObj = {
    EVENT_NAMES: EVENT_NAMES,
    request: httpRequest,
    on: function(eventName, handler) {
      var evName = (typeof eventName === 'string') ? eventName : String(eventName);
      logger.info('[lx-runtime] event registered: ' + evName);
      eventHandlers[evName] = handler;
      
      // Save all handlers - we'll figure out which is which by their behavior
      if (evName === 'undefined' || evName === 'null' || !evName || evName === 'inited') {
        // Could be the inited handler or requestMusicUrl handler
        // We'll trigger it to see
        setTimeout(function() {
          try {
            handler({});
          } catch(e) {
            logger.warn('[lx-runtime] inited handler error (non-fatal): ' + e.message.slice(0, 200));
          }
        }, 100);
      }
      
      // Save as potential musicUrl handler
      runtime.musicUrlHandler = handler;
      runtime._lastHandler = handler;
      runtime._lastEventName = evName;
    },
    send: function(eventName, data) {
      logger.info('[lx-runtime] send: ' + eventName);
      if (eventName === 'inited' || eventName === EVENT_NAMES.inited || (eventName === undefined && data && data.sources)) {
        initSent = true;
        initComplete = true;
        if (data && data.sources) {
          runtime.sources = data.sources;
        }
      }
      // Also accept any send with sources data
      if (data && data.sources) {
        runtime.sources = data.sources;
        initComplete = true;
      }
    },
    env: 'node',
    version: '1.7.0',
    currentScriptInfo: {
      rawScript: scriptCode.slice(0, 200),
      version: scriptVersion || '1',
    },
    utils: {
      crypto: {
        md5: md5,
        randomBytes: function(n) { return crypto.randomBytes(n); },
        bufToString: bufToString,
      },
      buffer: {
        from: bufFrom,
        alloc: bufAlloc,
        bufToString: bufToString,
      },
      stringify: JSON.stringify,
    },
  };

  // Create sandbox context
  const sandbox = {
    console: {
      log: function() { 
        var args = Array.prototype.slice.call(arguments);
        logger.info('[lx-script] ' + args.map(function(a) { return typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(' '));
      },
      error: function() {
        var args = Array.prototype.slice.call(arguments);
        logger.error('[lx-script] ' + args.join(' '));
      },
      warn: function() {
        var args = Array.prototype.slice.call(arguments);
        logger.warn('[lx-script] ' + args.join(' '));
      },
      info: function() {
        var args = Array.prototype.slice.call(arguments);
        logger.info('[lx-script] ' + args.join(' '));
      },
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Buffer: Buffer,
    Error: Error,
    Promise: Promise,
    JSON: JSON,
    parseInt: parseInt,
    parseFloat: parseFloat,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Array: Array,
    Object: Object,
    Math: Math,
    Date: Date,
    RegExp: RegExp,
    Symbol: Symbol,
    Map: Map,
    Set: Set,
    URL: URL,
    process: { platform: 'linux' },
    globalThis: null, // will be set below
  };
  sandbox.globalThis = sandbox;
  sandbox.lx = lxObj;

  const context = vm.createContext(sandbox);

  // Execute the source script with error handling
  try {
    vm.runInContext(scriptCode, context, { timeout: 5000 });
    logger.info('[lx-runtime] script loaded successfully');
  } catch (e) {
    logger.error('[lx-runtime] script execution error (non-fatal): ' + e.message.slice(0, 200));
    // Don't throw - we might still have registered handlers
  }

  // Wait for initialization
  runtime.waitForInit = function(timeoutMs) {
    return new Promise(function(resolve) {
      var start = Date.now();
      var check = function() {
        if (initComplete) {
          resolve(true);
        } else if (Date.now() - start > (timeoutMs || 10000)) {
          logger.warn('[lx-runtime] init timeout, continuing anyway');
          resolve(false);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  };

  // Resolve music URL using the loaded source
  runtime.resolveMusicUrl = function(source, musicInfo, quality) {
    if (!runtime.musicUrlHandler) {
      logger.warn('[lx-runtime] no musicUrl handler registered');
      return Promise.resolve(null);
    }
    
    return new Promise(function(resolve) {
      var resolved = false;
      try {
        var result = runtime.musicUrlHandler({
          source: source,
          action: 'musicUrl',
          info: {
            musicInfo: musicInfo,
            type: quality,
          },
        });
        
        if (result && typeof result.then === 'function') {
          result.then(function(url) {
            if (!resolved) { resolved = true; resolve(url); }
          }).catch(function(e) {
            logger.error('[lx-runtime] resolveMusicUrl promise error: ' + e.message.slice(0, 200));
            if (!resolved) { resolved = true; resolve(null); }
          });
          // Timeout fallback
          setTimeout(function() {
            if (!resolved) { resolved = true; resolve(null); }
          }, 20000);
        } else {
          resolve(result);
        }
      } catch(e) {
        logger.error('[lx-runtime] resolveMusicUrl error: ' + e.message.slice(0, 200));
        resolve(null);
      }
    });
  };

  // Search using the loaded source (if supported)
  runtime.search = function(keyword, page, limit) {
    if (!runtime.searchHandler) {
      return Promise.resolve(null);
    }
    return Promise.resolve(runtime.searchHandler({
      source: 'all',
      action: 'search',
      info: { keyword: keyword, page: page || 1, limit: limit || 20 },
    }).catch(function(e) {
      logger.error('[lx-runtime] search error: ' + e.message);
      return null;
    }));
  };

  runtime.getSources = function() {
    return runtime.sources;
  };

  return runtime;
}

module.exports = {
  createLxRuntime,
  EVENT_NAMES,
};

