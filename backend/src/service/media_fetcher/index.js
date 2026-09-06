const logger = require('consola');
const os = require('os');
const md5 = require('md5');
const path = require('path');
const cmd = require('../../utils/cmd');
const fs = require('fs');
const configManager = require('../config_manager')
const downloadFile = require('../../utils/download');

const { getBinPath } = require('./media_get');

// LX Source Bridge - lazy loaded
let lxSourceBridge = null;
async function getLxBridge() {
    if (lxSourceBridge === false) return null;
    if (!lxSourceBridge) {
        try {
            lxSourceBridge = require('../lx_source_bridge');
            await lxSourceBridge.init();
        } catch (e) {
            logger.warn('[media_fetcher] LX source bridge not available: ' + e.message);
            lxSourceBridge = false;
        }
    }
    return lxSourceBridge;
}

const basePath = path.join(os.tmpdir(), 'melody-tmp-songs');
if (!fs.existsSync(basePath)) {
    fs.mkdirSync(basePath);
}
logger.info(`[tmp path] use ${basePath}`)


async function downloadViaSourceUrl(url) {
    logger.info(`downloadViaSourceUrl params: url: ${url}`);

    const requestHash = md5(url);
    const downloadPath = `${basePath}/${requestHash}.mp3`;
    logger.info(`start download from ${url}`);

    const isSucceed = await downloadFile(url, downloadPath);
    if (!isSucceed) {
        logger.error(`download failed with ${url}`);
        return false;
    }

    if (!fs.existsSync(downloadPath)) {
        logger.error(`download failed with ${url}, the file not exists ${downloadPath}`);
        return false;
    }
    logger.info(`download success, path: ${downloadPath}`);
    return downloadPath;
}

// Try to download using LX source bridge first, fall back to direct URL
async function downloadViaSourceUrlWithLxFallback(searchItem) {
    const originalUrl = searchItem.url;
    
    // Try LX source bridge first
    try {
        const bridge = await getLxBridge();
        if (bridge) {
            const lxUrl = await Promise.race([
                bridge.resolveUrlFromSearchResult(searchItem),
                new Promise(resolve => setTimeout(() => resolve(null), 20000))
            ]);
            
            if (lxUrl) {
                logger.info(`[media_fetcher] trying LX source URL: ${lxUrl.slice(0, 80)}`);
                const result = await downloadViaSourceUrl(lxUrl);
                if (result) {
                    logger.info('[media_fetcher] LX source download succeeded');
                    return result;
                }
                logger.warn('[media_fetcher] LX source download failed, falling back to original URL');
            }
        }
    } catch (e) {
        logger.warn('[media_fetcher] LX source bridge error: ' + e.message);
    }
    
    // Fall back to original URL
    return await downloadViaSourceUrl(originalUrl);
}

async function fetchWithUrl(url, {
    songName = "",
    addMediaTag = false,
}) {
    logger.info(`fetchWithUrl params: ${JSON.stringify(arguments)}`);
    if (songName) {
        songName = songName.replace(/ /g, '').replace(/\./g, '').replace(/\//g, '').replace(/"/g, '');
    }
    const requestHash = md5(`${url}${songName}${addMediaTag}`);
    const fileBasePath = `${basePath}/${requestHash}`;
    try {
        fs.mkdirSync(fileBasePath, { recursive: true });
    } catch (err) {
        logger.error('create dir failed', err);
        return false;
    }

    addMediaTag = false;
    const downloadPath = `${fileBasePath}/${songName ? songName : requestHash}.mp3`;
    logger.info(`start parse and download from ${url}`);

    let args = ['-u', `"${url}"`, '--out', `${downloadPath}`, '-t', 'audio', `${addMediaTag ? '--addMediaTag' : ''}`];

    logger.info(`${getBinPath()} ${args.join(' ')}`);

    const {code, message} = await cmd(getBinPath(), args);
    logger.info('-------')
    logger.info(code);
    logger.info(message);
    logger.info('-------')
    if (code != 0) {
        return false;
    }

    if (!fs.existsSync(downloadPath)) {
        return false;
    }
    return downloadPath;
}

async function getMetaWithUrl(url) {
    logger.info(`getMetaWithUrl from ${url}`);

    let args = ['-u', `"${url}"`, '-m', '--infoFormat=json'];

    const {code, message} = await cmd(getBinPath(), args);
    logger.info('-------')
    logger.info(code);
    logger.info('-------')
    if (code != 0) {
        logger.error(`getMetaWithUrl failed with ${url}, err: ${message}`);
        // LX source fallback when media-get fails
        try {
            const bridge = await getLxBridge();
            if (bridge) {
                // Try to detect source from URL
                const sources = bridge.SOURCE_MAP;
                let detectedSource = null;
                for (const [mgSource, lxCode] of Object.entries(sources)) {
                    if (url.includes(mgSource) || (mgSource === 'kuwo' && url.includes('kuwo')) ||
                        (mgSource === 'netease' && url.includes('163.com')) ||
                        (mgSource === 'qq' && url.includes('qq.com')) ||
                        (mgSource === 'kugou' && url.includes('kugou')) ||
                        (mgSource === 'migu' && url.includes('migu'))) {
                        detectedSource = mgSource;
                        break;
                    }
                }
                if (detectedSource) {
                    logger.info('[media_fetcher] media-get failed, trying LX fallback for ' + detectedSource);
                    const lxUrl = await Promise.race([
                        bridge.resolveUrlFromSearchResult({
                            source: detectedSource,
                            url: url,
                            songName: '',
                            artist: '',
                        }),
                        new Promise(resolve => setTimeout(() => resolve(null), 8000))
                    ]);
                    if (lxUrl) {
                        logger.info('[media_fetcher] LX fallback resolved URL: ' + lxUrl.slice(0, 80));
                        return {
                            songName: '',
                            artist: '',
                            album: '',
                            duration: 0,
                            coverUrl: '',
                            publicTime: '',
                            isTrial: false,
                            resourceType: 'audio',
                            audios: [{ url: lxUrl, type: 'lx-source', quality: '128k' }],
                            fromMusicPlatform: true,
                            resourceForbidden: false,
                            source: detectedSource,
                        };
                    }
                }
            }
        } catch (e) {
            logger.warn('[media_fetcher] LX fallback failed: ' + e.message);
        }
        return false;
    }

    const meta = JSON.parse(message);

    const result = {
        songName: meta.title,
        artist: meta.artist,
        album: meta.album,
        duration: meta.duration,
        coverUrl: meta.cover_url,
        publicTime: meta.public_time,
        isTrial: meta.is_trial,
        resourceType: meta.resource_type,
        audios: meta.audios,
        fromMusicPlatform: meta.from_music_platform,
        resourceForbidden: meta.resource_forbidden,
        source: meta.source
    };

    // Try LX source enhancement for preview
    try {
        const bridge = await getLxBridge();
        if (bridge && meta.source) {
            const lxSourceCode = bridge.SOURCE_MAP[meta.source];
            if (lxSourceCode) {
                logger.info('[media_fetcher] trying LX source for meta: ' + meta.source + ' ' + (meta.title || ''));
                const lxUrl = await Promise.race([
                    bridge.resolveUrlFromSearchResult({
                        source: meta.source,
                        url: url,
                        songName: meta.title,
                        artist: meta.artist,
                    }),
                    new Promise(resolve => setTimeout(() => resolve(null), 8000))
                ]);
                if (lxUrl) {
                    if (!result.audios) result.audios = [];
                    result.audios.unshift({ url: lxUrl, type: 'lx-source', quality: '128k' });
                    result.isTrial = false;
                    result.resourceForbidden = false;
                    logger.info('[media_fetcher] LX enhanced meta with direct URL for ' + (meta.title || ''));
                }
            }
        }
    } catch (e) {
        logger.warn('[media_fetcher] LX meta enhancement failed: ' + e.message);
    }

    return result;
}

// Search songs - NO LX enhancement here, returns fast
async function searchSongFromAllPlatform({
    keyword,
    songName, artist, album
}) {
    logger.info(`searchSong with ${JSON.stringify(arguments)}`);

    const globalConfig = await configManager.getGlobalConfig();

    let searchParams = keyword 
        ? ['-k', `"${keyword}"`] 
        : ['--searchSongName', `"${songName}"`, '--searchArtist', `"${artist}"`, '--searchAlbum', `"${album}"`];
    searchParams = searchParams.concat([
        '--searchType="song"',
        '-m',
        `--sources=${globalConfig.sources.join(',')}`,
        '--infoFormat=json',
        '-l', 'silence'
    ]);

    logger.info(`cmdStr: ${getBinPath()} ${searchParams.join(' ')}`);

    const {code, message} = await cmd(getBinPath(), searchParams);
    logger.info('-------')
    logger.info(code);
    logger.info('-------')
    if (code != 0) {
        logger.error(`searchSong failed, err: ${message}`);
        return false;
    }

    let jsonResponse;
    try {
        jsonResponse = JSON.parse(message);
    } catch (e) {
        logger.error(e)
        return false;
    }

    let results = jsonResponse.map(searchItem => {
        return {
            songName: searchItem.Name,
            artist: searchItem.Artist,
            album: searchItem.Album,
            duration: searchItem.Duration,
            url: searchItem.Url,
            sourceUrl: searchItem.Url,
            resourceForbidden: searchItem.ResourceForbidden,
            source: searchItem.Source,
            fromMusicPlatform: searchItem.FromMusicPlatform,
            score: searchItem.Score,
        }
    })

    // Note: LX source resolution happens in getMetaWithUrl (single request per preview)
    // to avoid triggering API rate limits from batch requests
    return results;
}

module.exports = {
    downloadViaSourceUrl: downloadViaSourceUrl,
    downloadViaSourceUrlWithLxFallback: downloadViaSourceUrlWithLxFallback,
    fetchWithUrl: fetchWithUrl,
    getMetaWithUrl: getMetaWithUrl,
    searchSongFromAllPlatform: searchSongFromAllPlatform,
    getLxBridge: getLxBridge,
}
