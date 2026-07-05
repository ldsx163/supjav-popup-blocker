"use strict";

const http = require("http");
const https = require("https");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");
const fsp = fs.promises;

const defaultUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const defaultPlayer = "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe";

const args = parseArgs(process.argv.slice(2));
const manifestUrl = args.url || args.manifest || args._[0];
const hlsInput = /\.m3u8(?:[?#].*)?$/i.test(String(manifestUrl || ""));
const seekSeconds = parseTime(args.seek || args.start || "0");
const durationSeconds = parseTimeOrZero(args.duration || process.env.SUPJAV_DURATION || "0");
const exportTitle = args.title || process.env.SUPJAV_TITLE || "";
const exportPage = args.page || process.env.SUPJAV_PAGE || "";
const exportFileName = args.filename || args.file || process.env.SUPJAV_FILENAME || "";
const outputBaseName = safeFileName(exportFileName) || "video";
const userAgent = args.userAgent || args["user-agent"] || defaultUserAgent;
const origin = args.origin || "";
const referer = args.referer || "";
const playerPath = args.player || defaultPlayer;
const port = args.port ? Number(args.port) : 0;
const noOpen = Boolean(args["no-open"]);
const checkOnly = Boolean(args.check);
const resumeStateFile = args["resume-state"] ? path.resolve(String(args["resume-state"])) : "";
const proxyUrl = args["no-proxy"] ? null : normalizeProxy(args.proxy || getWindowsProxy());
const clipMode = Boolean(args.clip) || args.mode === "clip";
const cacheDir = path.resolve(args["cache-dir"] || path.join(__dirname, "supjav-potplayer-cache"));
const cacheSessionDir = path.join(cacheDir, cacheSessionName(manifestUrl || "session", exportFileName || exportTitle));
const hlsCacheDir = path.join(cacheSessionDir, "hls");
const mediaCacheDir = path.join(cacheSessionDir, "media");
const mediaChunkSize = 1024 * 1024;
const requestTimeoutMs = 60000;
const progressIntervalMs = 10000;

if (!manifestUrl) {
  usage();
  process.exit(2);
}

writeSessionInfo();

const requestHeaders = {
  "user-agent": userAgent
};
if (origin) requestHeaders.origin = origin;
if (referer) requestHeaders.referer = referer;

const hlsInFlight = new Map();
const mediaInFlight = new Map();
let hlsPrefetchRun = 0;
let mediaPrefetchRun = 0;
let hlsAppendPromise = Promise.resolve();
let mediaTotalSize = 0;
let lastHlsProgressAt = 0;
let lastMediaProgressAt = 0;
const cachedMediaMeta = readJson(path.join(cacheSessionDir, "media.json"));
if (cachedMediaMeta && Number.isFinite(Number(cachedMediaMeta.total))) {
  mediaTotalSize = Number(cachedMediaMeta.total);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

async function main() {
  if (!hlsInput) {
    await serveDirectMedia();
    return;
  }

  fs.mkdirSync(hlsCacheDir, { recursive: true });
  preparePartialFile("ts");

  const media = await resolveMediaPlaylist(manifestUrl);
  const playlist = parseMediaPlaylist(media.text, media.url);
  if (!playlist.segments.length) {
    throw new Error(`No HLS segments found: ${media.url}`);
  }

  const start = findStartSegment(playlist.segments, seekSeconds);

  if (checkOnly) {
    const buffer = await fetchBuffer(playlist.segments[start.index].url);
    const stripped = stripToMpegTs(buffer);
    console.log(`manifest: ${manifestUrl}`);
    console.log(`resolved: ${media.url}`);
    console.log(`mode: ${clipMode ? "clip" : "full"}`);
    console.log(`requested: ${formatSeconds(seekSeconds)} (${seekSeconds.toFixed(2)}s)`);
    console.log(`actual: ${formatSeconds(start.seconds)} (${start.seconds.toFixed(2)}s)`);
    console.log(`segment: ${start.index + 1}/${playlist.segments.length}`);
    console.log(`segment bytes: ${buffer.length}`);
    console.log(`served bytes: ${stripped.length}`);
    console.log(`stripped bytes: ${buffer.length - stripped.length}`);
    if (proxyUrl) console.log(`proxy: ${proxyUrl}`);
    return;
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res, media, playlist, start.index).catch((error) => {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(String(error && error.stack ? error.stack : error));
    });
  });

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const localUrl = `http://127.0.0.1:${address.port}/playlist.m3u8`;
    console.log(`Supjav TV proxy`);
    console.log(`source: ${manifestUrl}`);
    console.log(`resolved: ${media.url}`);
    console.log(`mode: ${clipMode ? "clip" : "full"}`);
    console.log(`requested: ${formatSeconds(seekSeconds)} (${seekSeconds.toFixed(2)}s)`);
    console.log(`actual: ${formatSeconds(start.seconds)} (${start.seconds.toFixed(2)}s)`);
    console.log(`local: ${localUrl}`);
    console.log(`cache: ${cacheSessionDir}`);
    console.log(`partial: ${partialVideoPath("ts")}`);
    console.log(`complete: ${completeVideoPath("ts")}`);
    if (resumeStateFile) console.log(`resume state: ${resumeStateFile}`);
    if (proxyUrl) console.log(`proxy: ${proxyUrl}`);
    console.log(`progress: prints every ${progressIntervalMs / 1000}s while cache advances`);
    console.log(`Press Ctrl+C after PotPlayer is closed.`);

    if (!noOpen) {
      const playerArgs = clipMode ? [localUrl, "/new"] : [localUrl, `/seek=${formatPotSeek(seekSeconds)}`, "/new"];
      spawn(playerPath, playerArgs, {
        detached: true,
        stdio: "ignore",
        windowsHide: false
      }).unref();
    }
  });
}

async function serveDirectMedia() {
  fs.mkdirSync(mediaCacheDir, { recursive: true });
  preparePartialFile("mp4");

  if (checkOnly) {
    const response = await requestBuffer(manifestUrl, { range: "bytes=0-1023" });
    console.log(`media: ${manifestUrl}`);
    console.log(`resolved: ${response.url || manifestUrl}`);
    console.log(`status: ${response.status}`);
    console.log(`content-type: ${response.headers["content-type"] || ""}`);
    if (response.headers["content-range"]) console.log(`content-range: ${response.headers["content-range"]}`);
    if (response.headers["content-length"]) console.log(`content-length: ${response.headers["content-length"]}`);
    console.log(`bytes: ${response.body.length}`);
    if (proxyUrl) console.log(`proxy: ${proxyUrl}`);
    return;
  }

  const server = http.createServer((req, res) => {
    handleDirectMediaRequest(req, res).catch((error) => {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(String(error && error.stack ? error.stack : error));
    });
  });

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const localUrl = `http://127.0.0.1:${address.port}/video.mp4`;
    console.log(`Supjav media proxy`);
    console.log(`source: ${manifestUrl}`);
    console.log(`requested: ${formatSeconds(seekSeconds)} (${seekSeconds.toFixed(2)}s)`);
    console.log(`local: ${localUrl}`);
    console.log(`cache: ${cacheSessionDir}`);
    console.log(`partial: ${partialVideoPath("mp4")}`);
    console.log(`complete: ${completeVideoPath("mp4")}`);
    if (resumeStateFile) console.log(`resume state: ${resumeStateFile}`);
    if (proxyUrl) console.log(`proxy: ${proxyUrl}`);
    console.log(`progress: prints every ${progressIntervalMs / 1000}s while cache advances`);
    console.log(`Press Ctrl+C after PotPlayer is closed.`);

    if (!noOpen) {
      spawn(playerPath, [localUrl, `/seek=${formatPotSeek(seekSeconds)}`, "/new"], {
        detached: true,
        stdio: "ignore",
        windowsHide: false
      }).unref();
    }
  });
}

async function handleDirectMediaRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname !== "/" && url.pathname !== "/video.mp4") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("content-type", "video/mp4");
    res.setHeader("accept-ranges", "bytes");
    if (mediaTotalSize) res.setHeader("content-length", String(mediaTotalSize));
    res.end();
    return;
  }

  const requested = parseRangeHeader(req.headers.range);
  if (requested && mediaTotalSize) {
    const start = Math.min(requested.start, mediaTotalSize - 1);
    const end = Math.min(requested.end ?? (start + mediaChunkSize - 1), mediaTotalSize - 1);
    await serveMediaRangeFromCache(start, end, res);
    writeMediaResume(start);
    startMediaPrefetch(Math.floor((end + 1) / mediaChunkSize));
    return;
  }

  if (requested && !mediaTotalSize) {
    const end = requested.end ?? (requested.start + mediaChunkSize - 1);
    const response = await requestBuffer(manifestUrl, { range: `bytes=${requested.start}-${end}` });
    const range = parseContentRange(response.headers["content-range"]);
    if (range) setMediaTotalSize(range.total);
    const start = range?.start ?? requested.start;
    const actualEnd = range?.end ?? (start + response.body.length - 1);
    await writeCompleteMp4(response.body, start);
    writeMediaResume(start);
    res.statusCode = response.status;
    copyResponseHeaders(response.headers, res);
    res.end(response.body);
    startMediaPrefetch(Math.floor((actualEnd + 1) / mediaChunkSize));
    return;
  }

  const extraHeaders = {};
  const upstream = await requestStream(manifestUrl, extraHeaders);
  res.statusCode = upstream.status;
  copyResponseHeaders(upstream.headers, res);
  upstream.stream.on("error", (error) => res.destroy(error));
  res.on("close", () => upstream.stream.destroy());
  upstream.stream.pipe(res);
}

async function handleRequest(req, res, media, playlist, startIndex) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const localBase = `${url.protocol}//${url.host}`;

  if (url.pathname === "/" || url.pathname === "/playlist.m3u8") {
    const text = buildPlaylist(media.url, playlist, clipMode ? startIndex : 0, localBase, clipMode ? 0 : seekSeconds);
    res.statusCode = 200;
    res.setHeader("content-type", "application/vnd.apple.mpegurl; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(text);
    return;
  }

  if (url.pathname.startsWith("/seg/") && url.pathname.endsWith(".ts")) {
    const index = Number(url.pathname.match(/\/seg\/(\d+)\.ts$/)?.[1]);
    const segment = playlist.segments[index];
    if (!segment) {
      res.statusCode = 404;
      res.end("segment not found");
      return;
    }

    const body = await getCachedSegment(index, segment.url, playlist);
    writeResumeState(segmentStartSeconds(playlist.segments, index), {
      kind: "hls",
      segment: index + 1,
      totalSegments: playlist.segments.length,
      duration: playlistDuration(playlist.segments)
    });
    startHlsPrefetch((index + 1) % playlist.segments.length, playlist);
    res.statusCode = 200;
    res.setHeader("content-type", "video/MP2T");
    res.setHeader("content-length", String(body.length));
    res.setHeader("cache-control", "public, max-age=600");
    res.end(body);
    return;
  }

  if (url.pathname === "/raw") {
    const target = url.searchParams.get("u");
    if (!target) {
      res.statusCode = 400;
      res.end("missing u");
      return;
    }
    const response = await requestBuffer(target);
    const body = response.body;
    res.statusCode = response.status;
    res.setHeader("content-type", response.headers["content-type"] || "application/octet-stream");
    res.setHeader("content-length", String(body.length));
    res.end(body);
    return;
  }

  res.statusCode = 404;
  res.end("not found");
}

function buildPlaylist(baseUrl, playlist, startIndex, localBase, startHintSeconds) {
  const out = [];
  for (const line of playlist.header) {
    if (line === "#EXTM3U") {
      out.push(line);
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:") || line.startsWith("#EXT-X-START:")) continue;
    out.push(rewriteTagUris(line, baseUrl, localBase));
  }

  if (!out.length || out[0] !== "#EXTM3U") out.unshift("#EXTM3U");
  if (startHintSeconds > 0) {
    out.push(`#EXT-X-START:TIME-OFFSET=${Number(startHintSeconds).toFixed(3)},PRECISE=YES`);
  }
  out.push("#EXT-X-MEDIA-SEQUENCE:0");

  for (let index = startIndex; index < playlist.segments.length; index += 1) {
    const segment = playlist.segments[index];
    for (const tag of segment.tags) {
      out.push(rewriteTagUris(tag, baseUrl, localBase));
    }
    out.push(`${localBase}/seg/${index}.ts`);
  }

  if (playlist.endList) out.push("#EXT-X-ENDLIST");
  return `${out.join("\r\n")}\r\n`;
}

async function resolveMediaPlaylist(url) {
  const media = await fetchTextBestEffort(url);
  const text = media.text;
  const baseUrl = media.url || url;
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

    let nextUrl = "";
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const candidate = lines[scan];
      if (!candidate || candidate.startsWith("#")) continue;
      nextUrl = candidate;
      break;
    }
    if (!nextUrl) continue;

    const bandwidth = Number(line.match(/BANDWIDTH=(\d+)/)?.[1] || 0);
    variants.push({
      bandwidth,
      url: new URL(nextUrl, baseUrl).href
    });
  }

  if (!variants.length) return { url: baseUrl, text };

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  let lastError;
  for (const variant of variants) {
    try {
      const resolved = await fetchTextBestEffort(variant.url);
      return { url: resolved.url || variant.url, text: resolved.text };
    } catch (error) {
      lastError = error;
      console.log(`[variant] ${variant.url} failed: ${shortError(error)}`);
    }
  }

  throw lastError || new Error(`No playable HLS variant found: ${url}`);
}

function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = [];
  const segments = [];
  let pendingTags = [];
  let currentInf = "";
  let endList = false;
  let inSegments = false;

  for (const line of lines) {
    if (line === "#EXT-X-ENDLIST") {
      endList = true;
      continue;
    }

    if (!inSegments && !line.startsWith("#EXTINF:")) {
      header.push(line);
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      inSegments = true;
      currentInf = line;
      continue;
    }

    if (line.startsWith("#")) {
      pendingTags.push(line);
      continue;
    }

    if (!currentInf) continue;

    segments.push({
      duration: Number(currentInf.match(/^#EXTINF:([\d.]+)/)?.[1] || 0),
      url: new URL(line, baseUrl).href,
      tags: [...pendingTags, currentInf]
    });
    pendingTags = [];
    currentInf = "";
  }

  return { header, segments, endList };
}

function findStartSegment(segments, seek) {
  let cursor = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const next = cursor + segments[index].duration;
    if (next > seek) return { index, seconds: cursor };
    cursor = next;
  }

  const index = Math.max(0, segments.length - 1);
  return { index, seconds: Math.max(0, cursor - (segments[index]?.duration || 0)) };
}

async function getCachedSegment(index, url, playlist) {
  const file = hlsSegmentPath(index);
  if (fs.existsSync(file)) {
    queueAppendHls(playlist);
    return fsp.readFile(file);
  }
  if (hlsInFlight.has(index)) return hlsInFlight.get(index);

  const promise = (async () => {
    const label = `HLS segment ${index + 1}/${playlist.segments.length}`;
    const body = stripToMpegTs(await fetchBufferWithRetry(url, label));
    await fsp.mkdir(hlsCacheDir, { recursive: true });
    await writeFileAtomic(file, body);
    queueAppendHls(playlist);
    logHlsProgress(playlist);
    return body;
  })().finally(() => hlsInFlight.delete(index));

  hlsInFlight.set(index, promise);
  return promise;
}

function startHlsPrefetch(startIndex, playlist) {
  if (!playlist.segments.length) return;
  const run = ++hlsPrefetchRun;
  const start = ((startIndex % playlist.segments.length) + playlist.segments.length) % playlist.segments.length;

  (async () => {
    while (run === hlsPrefetchRun) {
      let failed = 0;
      for (let offset = 0; offset < playlist.segments.length; offset += 1) {
        if (run !== hlsPrefetchRun) return;
        const index = (start + offset) % playlist.segments.length;
        const segment = playlist.segments[index];
        if (fs.existsSync(hlsSegmentPath(index))) continue;
        try {
          await getCachedSegment(index, segment.url, playlist);
        } catch (error) {
          failed += 1;
          console.log(`[prefetch] HLS segment ${index + 1}/${playlist.segments.length} failed: ${shortError(error)}`);
          await delay(5000);
        }
      }
      logHlsProgress(playlist, true);
      if (countHlsSegments(playlist.segments.length) >= playlist.segments.length) return;
      await delay(failed ? 15000 : 3000);
    }
  })().catch((error) => console.log(`[prefetch] stopped: ${shortError(error)}`));
}

function queueAppendHls(playlist) {
  hlsAppendPromise = hlsAppendPromise
    .then(() => appendHlsFromDisk(playlist))
    .catch((error) => console.log(`[cache] append failed: ${shortError(error)}`));
  return hlsAppendPromise;
}

async function appendHlsFromDisk(playlist) {
  const stateFile = path.join(cacheSessionDir, "complete-ts.json");
  const partialFile = partialVideoPath("ts");
  const completeFile = completeVideoPath("ts");
  const state = readJson(stateFile) || {};
  let nextIndex = Number(state.nextIndex) || 0;

  while (nextIndex < playlist.segments.length && fs.existsSync(hlsSegmentPath(nextIndex))) {
    await fsp.appendFile(partialFile, await fsp.readFile(hlsSegmentPath(nextIndex)));
    nextIndex += 1;
    await writeJsonAtomic(stateFile, { nextIndex, total: playlist.segments.length, updatedAt: new Date().toISOString() });
  }

  if (nextIndex >= playlist.segments.length) {
    if (!fs.existsSync(completeFile) && fs.existsSync(partialFile)) {
      await fsp.rename(partialFile, completeFile);
      console.log(`[cache] HLS complete: ${completeFile}`);
    }
    await fsp.writeFile(path.join(cacheSessionDir, "complete.done"), `${path.basename(completeFile)}\n${new Date().toISOString()}\n`);
  }
}

async function serveMediaRangeFromCache(start, end, res) {
  const firstChunk = Math.floor(start / mediaChunkSize);
  const lastChunk = Math.floor(end / mediaChunkSize);
  for (let index = firstChunk; index <= lastChunk; index += 1) {
    await ensureMediaChunk(index);
  }

  res.statusCode = 206;
  res.setHeader("content-type", "video/mp4");
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("content-range", `bytes ${start}-${end}/${mediaTotalSize}`);
  res.setHeader("content-length", String(end - start + 1));
  res.setHeader("cache-control", "public, max-age=600");

  for (let index = firstChunk; index <= lastChunk; index += 1) {
    const chunkStart = index * mediaChunkSize;
    const file = mediaChunkPath(index);
    const stat = await fsp.stat(file);
    const sliceStart = Math.max(0, start - chunkStart);
    const sliceEnd = Math.min(stat.size - 1, end - chunkStart);
    if (sliceEnd >= sliceStart) await pipeFileSlice(file, sliceStart, sliceEnd, res);
  }
  res.end();
}

function startMediaPrefetch(startChunk) {
  if (!mediaTotalSize) return;
  const totalChunks = Math.ceil(mediaTotalSize / mediaChunkSize);
  if (!totalChunks) return;
  const run = ++mediaPrefetchRun;
  const start = ((startChunk % totalChunks) + totalChunks) % totalChunks;

  (async () => {
    for (let offset = 0; offset < totalChunks; offset += 1) {
      if (run !== mediaPrefetchRun) return;
      await ensureMediaChunk((start + offset) % totalChunks);
    }
    await markMediaCompleteIfDone();
  })().catch((error) => console.log(`[prefetch] stopped: ${shortError(error)}`));
}

async function ensureMediaChunk(index) {
  if (!mediaTotalSize && index > 0) return;
  const start = index * mediaChunkSize;
  if (mediaTotalSize && start >= mediaTotalSize) return;
  const file = mediaChunkPath(index);
  if (fs.existsSync(file)) return;
  if (mediaInFlight.has(index)) return mediaInFlight.get(index);

  const promise = (async () => {
    const end = mediaTotalSize ? Math.min(mediaTotalSize - 1, start + mediaChunkSize - 1) : start + mediaChunkSize - 1;
    const label = `media chunk ${index + 1}`;
    const response = await requestBufferWithRetry(manifestUrl, { range: `bytes=${start}-${end}` }, label);
    const range = parseContentRange(response.headers["content-range"]);
    if (range) setMediaTotalSize(range.total);
    await fsp.mkdir(mediaCacheDir, { recursive: true });
    await writeFileAtomic(file, response.body);
    await writeCompleteMp4(response.body, range?.start ?? start);
    await markMediaCompleteIfDone();
    logMediaProgress();
  })().finally(() => mediaInFlight.delete(index));

  mediaInFlight.set(index, promise);
  return promise;
}

async function writeCompleteMp4(buffer, offset) {
  await fsp.mkdir(cacheSessionDir, { recursive: true });
  const file = partialVideoPath("mp4");
  let handle;
  try {
    handle = await fsp.open(file, "r+");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    handle = await fsp.open(file, "w+");
  }
  try {
    if (mediaTotalSize) await handle.truncate(mediaTotalSize);
    await handle.write(buffer, 0, buffer.length, offset);
  } finally {
    await handle.close();
  }
}

async function markMediaCompleteIfDone() {
  if (!mediaTotalSize) return;
  const totalChunks = Math.ceil(mediaTotalSize / mediaChunkSize);
  for (let index = 0; index < totalChunks; index += 1) {
    if (!fs.existsSync(mediaChunkPath(index))) return;
  }
  const partialFile = partialVideoPath("mp4");
  const completeFile = completeVideoPath("mp4");
  if (!fs.existsSync(completeFile) && fs.existsSync(partialFile)) {
    await fsp.rename(partialFile, completeFile);
    console.log(`[cache] MP4 complete: ${completeFile}`);
  }
  await fsp.writeFile(path.join(cacheSessionDir, "complete.done"), `${path.basename(completeFile)}\n${new Date().toISOString()}\n`);
}

function hlsSegmentPath(index) {
  return path.join(hlsCacheDir, `${String(index).padStart(6, "0")}.ts`);
}

function mediaChunkPath(index) {
  return path.join(mediaCacheDir, `${String(index).padStart(6, "0")}.bin`);
}

function parseRangeHeader(value) {
  const match = String(value || "").match(/^bytes=(\d+)-(\d*)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  if (!Number.isFinite(start) || start < 0) return null;
  if (end !== null && (!Number.isFinite(end) || end < start)) return null;
  return { start, end };
}

function parseContentRange(value) {
  const match = String(value || "").match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  const total = match[3] === "*" ? 0 : Number(match[3]);
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total
  };
}

function setMediaTotalSize(total) {
  if (!Number.isFinite(total) || total <= 0) return;
  if (mediaTotalSize === total) return;
  mediaTotalSize = total;
  fs.mkdirSync(cacheSessionDir, { recursive: true });
  fs.writeFileSync(path.join(cacheSessionDir, "media.json"), JSON.stringify({
    total,
    chunkSize: mediaChunkSize,
    source: manifestUrl,
    updatedAt: new Date().toISOString()
  }, null, 2));
}

function preparePartialFile(ext) {
  const doneFile = path.join(cacheSessionDir, "complete.done");
  const completeFile = completeVideoPath(ext);
  const partialFile = partialVideoPath(ext);
  if (fs.existsSync(doneFile) || !fs.existsSync(completeFile) || fs.existsSync(partialFile)) return;
  fs.mkdirSync(cacheSessionDir, { recursive: true });
  fs.renameSync(completeFile, partialFile);
}

function partialVideoPath(ext) {
  return path.join(cacheSessionDir, `${outputBaseName}.partial.${ext}`);
}

function completeVideoPath(ext) {
  return path.join(cacheSessionDir, `${outputBaseName}.${ext}`);
}

function writeMediaResume(byteStart) {
  if (!durationSeconds || !mediaTotalSize || byteStart <= 0) return;
  writeResumeState((byteStart / mediaTotalSize) * durationSeconds, {
    kind: "mp4",
    byteStart,
    totalBytes: mediaTotalSize,
    duration: durationSeconds
  });
}

function writeResumeState(seconds, extra = {}) {
  if (!resumeStateFile) return;
  const value = Math.max(0, Number(seconds) || 0);
  const tmp = `${resumeStateFile}.tmp`;
  const data = {
    ...extra,
    seconds: value,
    clock: formatPotSeek(value),
    source: manifestUrl,
    file: outputBaseName,
    updatedAt: new Date().toISOString()
  };

  try {
    fs.mkdirSync(path.dirname(resumeStateFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, resumeStateFile);
  } catch (error) {
    console.log(`[resume] write failed: ${shortError(error)}`);
  }
}

function segmentStartSeconds(segments, targetIndex) {
  let seconds = 0;
  for (let index = 0; index < targetIndex; index += 1) {
    seconds += Number(segments[index]?.duration) || 0;
  }
  return seconds;
}

function playlistDuration(segments) {
  return segments.reduce((total, segment) => total + (Number(segment.duration) || 0), 0);
}

function logHlsProgress(playlist, force = false) {
  const now = Date.now();
  if (!force && now - lastHlsProgressAt < progressIntervalMs) return;
  lastHlsProgressAt = now;
  const cached = countHlsSegments(playlist.segments.length);
  const bytes = fileSize(partialVideoPath("ts"));
  console.log(`[cache] HLS ${cached}/${playlist.segments.length} segments, ${formatBytes(bytes)} written`);
}

function logMediaProgress(force = false) {
  const now = Date.now();
  if (!force && now - lastMediaProgressAt < progressIntervalMs) return;
  lastMediaProgressAt = now;
  const bytes = fileSize(partialVideoPath("mp4"));
  const total = mediaTotalSize ? ` / ${formatBytes(mediaTotalSize)}` : "";
  console.log(`[cache] MP4 ${formatBytes(bytes)}${total} written`);
}

function countHlsSegments(total) {
  let count = 0;
  for (let index = 0; index < total; index += 1) {
    if (fs.existsSync(hlsSegmentPath(index))) count += 1;
  }
  return count;
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function writeSessionInfo() {
  fs.mkdirSync(cacheSessionDir, { recursive: true });
  fs.writeFileSync(path.join(cacheSessionDir, "info.txt"), [
    `File: ${outputBaseName}`,
    `Title: ${exportTitle || ""}`,
    `Page: ${exportPage || ""}`,
    `Source: ${manifestUrl || ""}`,
    `Duration: ${durationSeconds || ""}`,
    `Resume state: ${resumeStateFile || ""}`,
    `Created: ${new Date().toISOString()}`
  ].join("\r\n"));
}

function cacheSessionName(url, title) {
  const hash = shortHash(url || "session");
  const name = safeFileName(title);
  return name ? `${name}-${hash}` : hash;
}

function safeFileName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
}

async function pipeFileSlice(file, start, end, res) {
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { start, end });
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res, { end: false });
  });
}

async function writeFileAtomic(file, body) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, body);
  await fsp.rename(tmp, file);
}

async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, Buffer.from(JSON.stringify(value, null, 2)));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function shortHash(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 16);
}

async function fetchText(url) {
  const response = await requestBuffer(url);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  return response.body.toString("utf8");
}

async function fetchTextBestEffort(url) {
  try {
    const response = await requestBuffer(url);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }
    return { text: response.body.toString("utf8"), url: response.url || url };
  } catch (error) {
    if (!proxyUrl) throw error;
    console.log(`[network] proxy failed, trying direct: ${shortError(error)}`);
    const response = await requestBufferDirect(url);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }
    return { text: response.body.toString("utf8"), url: response.url || url };
  }
}

async function fetchBuffer(url) {
  const response = await requestBuffer(url);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  return response.body;
}

async function fetchBufferWithRetry(url, label, attempts = 2) {
  const response = await requestBufferWithRetry(url, {}, label, attempts);
  return response.body;
}

async function requestBufferWithRetry(url, extraHeaders = {}, label = url, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await requestBuffer(url, extraHeaders);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status} fetching ${url}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      console.log(`[retry] ${label}: ${shortError(error)}; retry ${attempt + 1}/${attempts}`);
      await delay(2000 * attempt);
    }
  }
  throw lastError;
}

async function requestBuffer(url, extraHeaders = {}, redirects = 5) {
  let current = url;
  for (let count = 0; count <= redirects; count += 1) {
    const response = await requestOnce(current, extraHeaders);
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      current = new URL(location, current).href;
      continue;
    }
    return { ...response, url: current };
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

async function requestBufferDirect(url, extraHeaders = {}, redirects = 5) {
  let current = url;
  for (let count = 0; count <= redirects; count += 1) {
    const response = await requestDirect(new URL(current), extraHeaders);
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      current = new URL(location, current).href;
      continue;
    }
    return { ...response, url: current };
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

function requestOnce(url, extraHeaders = {}) {
  const target = new URL(url);
  if (proxyUrl) return requestViaProxy(target, extraHeaders);
  return requestDirect(target, extraHeaders);
}

function requestDirect(target, extraHeaders = {}) {
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(target, {
      method: "GET",
      headers: {
        ...requestHeaders,
        ...extraHeaders
      },
      timeout: requestTimeoutMs
    }, (res) => collectResponse(res, resolve, reject));

    req.on("timeout", () => req.destroy(new Error(`Timeout fetching ${target.href}`)));
    req.on("error", reject);
    req.end();
  });
}

function requestViaProxy(target, extraHeaders = {}) {
  const proxy = new URL(proxyUrl);
  if (target.protocol === "http:") {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: proxy.hostname,
        port: proxy.port || 80,
        method: "GET",
        path: target.href,
        headers: {
          ...requestHeaders,
          ...extraHeaders,
          host: target.host
        },
        timeout: requestTimeoutMs
      }, (res) => collectResponse(res, resolve, reject));

      req.on("timeout", () => req.destroy(new Error(`Timeout fetching ${target.href} through ${proxyUrl}`)));
      req.on("error", reject);
      req.end();
    });
  }

  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: {
        host: `${target.hostname}:${target.port || 443}`
      },
      timeout: requestTimeoutMs
    });

    connect.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT ${res.statusCode} for ${target.hostname}`));
        return;
      }

      const secureSocket = tls.connect({
        socket,
        servername: target.hostname
      }, () => {
        const agent = new https.Agent({ keepAlive: false });
        agent.createConnection = () => secureSocket;
        const req = https.request({
          hostname: target.hostname,
          port: target.port || 443,
          method: "GET",
          path: `${target.pathname}${target.search}`,
          headers: {
            ...requestHeaders,
            ...extraHeaders,
            host: target.host
          },
          agent,
          timeout: requestTimeoutMs
        }, (response) => collectResponse(response, resolve, reject));

        req.on("timeout", () => req.destroy(new Error(`Timeout fetching ${target.href} through ${proxyUrl}`)));
        req.on("error", reject);
        req.end();
      });

      secureSocket.on("error", reject);
    });

    connect.on("timeout", () => connect.destroy(new Error(`Timeout connecting to proxy ${proxyUrl}`)));
    connect.on("error", reject);
    connect.end();
  });
}

async function requestStream(url, extraHeaders = {}, redirects = 5) {
  let current = url;
  for (let count = 0; count <= redirects; count += 1) {
    const response = await requestOnceStream(current, extraHeaders);
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      response.stream.resume();
      current = new URL(location, current).href;
      continue;
    }
    return { ...response, url: current };
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

function requestOnceStream(url, extraHeaders = {}) {
  const target = new URL(url);
  if (proxyUrl) return requestViaProxyStream(target, extraHeaders);
  return requestDirectStream(target, extraHeaders);
}

function requestDirectStream(target, extraHeaders = {}) {
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(target, {
      method: "GET",
      headers: {
        ...requestHeaders,
        ...extraHeaders
      },
      timeout: requestTimeoutMs
    }, (res) => resolve({
      status: res.statusCode || 0,
      headers: res.headers,
      stream: res
    }));

    req.on("timeout", () => req.destroy(new Error(`Timeout fetching ${target.href}`)));
    req.on("error", reject);
    req.end();
  });
}

function requestViaProxyStream(target, extraHeaders = {}) {
  const proxy = new URL(proxyUrl);
  if (target.protocol === "http:") {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: proxy.hostname,
        port: proxy.port || 80,
        method: "GET",
        path: target.href,
        headers: {
          ...requestHeaders,
          ...extraHeaders,
          host: target.host
        },
        timeout: requestTimeoutMs
      }, (res) => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        stream: res
      }));

      req.on("timeout", () => req.destroy(new Error(`Timeout fetching ${target.href} through ${proxyUrl}`)));
      req.on("error", reject);
      req.end();
    });
  }

  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: {
        host: `${target.hostname}:${target.port || 443}`
      },
      timeout: requestTimeoutMs
    });

    connect.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT ${res.statusCode} for ${target.hostname}`));
        return;
      }

      const secureSocket = tls.connect({
        socket,
        servername: target.hostname
      }, () => {
        const agent = new https.Agent({ keepAlive: false });
        agent.createConnection = () => secureSocket;
        const req = https.request({
          hostname: target.hostname,
          port: target.port || 443,
          method: "GET",
          path: `${target.pathname}${target.search}`,
          headers: {
            ...requestHeaders,
            ...extraHeaders,
            host: target.host
          },
          agent,
          timeout: requestTimeoutMs
        }, (response) => resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          stream: response
        }));

        req.on("timeout", () => req.destroy(new Error(`Timeout fetching ${target.href} through ${proxyUrl}`)));
        req.on("error", reject);
        req.end();
      });

      secureSocket.on("error", reject);
    });

    connect.on("timeout", () => connect.destroy(new Error(`Timeout connecting to proxy ${proxyUrl}`)));
    connect.on("error", reject);
    connect.end();
  });
}

function copyResponseHeaders(headers, res) {
  const allowed = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control"
  ];

  for (const name of allowed) {
    const value = headers[name];
    if (value !== undefined) res.setHeader(name, value);
  }
  if (!res.hasHeader("accept-ranges")) res.setHeader("accept-ranges", "bytes");
  if (!res.hasHeader("content-type")) res.setHeader("content-type", "video/mp4");
}

function collectResponse(response, resolve, reject) {
  const chunks = [];
  response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  response.on("end", () => {
    resolve({
      status: response.statusCode || 0,
      headers: response.headers,
      body: Buffer.concat(chunks)
    });
  });
  response.on("error", reject);
}

function stripToMpegTs(buffer) {
  const offset = findMpegTsOffset(buffer);
  return offset > 0 ? buffer.subarray(offset) : buffer;
}

function findMpegTsOffset(buffer) {
  const max = Math.min(buffer.length - (188 * 4), 65536);
  for (let offset = 0; offset < max; offset += 1) {
    if (buffer[offset] !== 0x47) continue;

    let ok = true;
    for (let packet = 1; packet < 5; packet += 1) {
      if (buffer[offset + packet * 188] !== 0x47) {
        ok = false;
        break;
      }
    }
    if (ok) return offset;
  }
  return 0;
}

function rewriteTagUris(line, baseUrl, localBase) {
  return line.replace(/URI="([^"]+)"/g, (_match, value) => {
    const absolute = new URL(value, baseUrl).href;
    return `URI="${localBase}/raw?u=${encodeURIComponent(absolute)}"`;
  });
}

function getWindowsProxy() {
  if (process.platform !== "win32") return "";

  try {
    const enabled = execFileSync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v",
      "ProxyEnable"
    ], { encoding: "utf8", windowsHide: true });
    if (!/\b0x1\b/i.test(enabled)) return "";

    const server = execFileSync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v",
      "ProxyServer"
    ], { encoding: "utf8", windowsHide: true });
    return server.match(/ProxyServer\s+REG_SZ\s+(.+)\s*$/im)?.[1]?.trim() || "";
  } catch {
    return "";
  }
}

function normalizeProxy(value) {
  if (!value) return "";
  const text = String(value).trim();
  const httpsPart = text.match(/(?:^|;)https=([^;]+)/i)?.[1];
  const httpPart = text.match(/(?:^|;)http=([^;]+)/i)?.[1];
  const proxy = httpsPart || httpPart || text.split(";")[0];
  if (!proxy) return "";
  return /^https?:\/\//i.test(proxy) ? proxy : `http://${proxy}`;
}

function parseArgs(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      result._.push(value);
      continue;
    }

    const eq = value.indexOf("=");
    if (eq !== -1) {
      result[value.slice(2, eq)] = value.slice(eq + 1);
      continue;
    }

    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    index += 1;
  }
  return result;
}

function parseTime(value) {
  if (typeof value === "number") return value;
  const text = String(value || "0").trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);

  const parts = text.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  throw new Error(`Unsupported time: ${value}`);
}

function parseTimeOrZero(value) {
  try {
    return parseTime(value);
  } catch {
    return 0;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortError(error) {
  return String((error && error.message) || error || "unknown error");
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatSeconds(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const whole = Math.floor(seconds);
  const hh = String(Math.floor(whole / 3600)).padStart(2, "0");
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const ss = String(whole % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatPotSeek(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const whole = Math.floor(seconds);
  const fraction = Math.round((seconds - whole) * 100);
  return `${formatSeconds(whole)}.${String(fraction).padStart(2, "0")}`;
}

function usage() {
  console.error(
    [
      "Usage:",
      '  node "C:\\tmp\\supjav-potplayer-proxy.js" --url "<m3u8-or-mp4>" --seek 5042.90 --origin "https://turbovidhls.com"',
      "",
      "Options:",
      "  --referer <url>",
      "  --user-agent <ua>",
      "  --filename <name>",
      "  --duration <seconds>",
      "  --resume-state <json-file>",
      "  --player <PotPlayerMini64.exe>",
      "  --cache-dir <dir>",
      "  --clip",
      "  --no-open",
      "  --check"
    ].join("\n")
  );
}
