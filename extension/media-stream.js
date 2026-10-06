// Native media elements use this Extension-origin route. The worker streams
// the Agent response without collecting the file in a Blob or an ArrayBuffer.
export const MEDIA_STREAM_ROUTE = '/_researchtube/workspace-media';

export function createMediaStreamHandler({ extensionUrl, getClient, resolveMedia, fetchMedia, log = () => {} }) {
  const base = new URL(extensionUrl);
  const own = url => url.protocol === base.protocol && url.host === base.host;
  const isViewer = value => {
    try { const url = new URL(value); return own(url) && url.pathname === '/media-viewer.html'; }
    catch { return false; }
  };
  const failure = (status, message) => new Response(message, { status,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  async function respond(event, url) {
    try {
      const request = event.request;
      if (!['GET', 'HEAD'].includes(request.method)) return failure(405, 'Only media reads are supported.');
      const client = event.clientId ? await getClient(event.clientId) : null;
      // Some Extension requests have no clientId; an Extension-owned viewer
      // referrer is the only fallback, never a web page or another Extension.
      if (!isViewer(client?.url || (!event.clientId ? request.referrer : ''))) return failure(403, 'The media request is not from a ResearchTube viewer.');
      if ([...url.searchParams.keys()].some(key => !['path', 'reload'].includes(key))
        || url.searchParams.getAll('path').length !== 1 || (url.searchParams.get('reload') || '').length > 80) {
        return failure(400, 'Invalid media request.');
      }
      const path = url.searchParams.get('path');
      if (!path || path.length > 4096 || request.signal.aborted) return failure(400, 'Invalid or stopped media request.');
      // resolveMedia independently validates the logical Workspace path and
      // obtains an allowlisted type from the Agent. No caller supplies a URL.
      const media = await resolveMedia(path);
      if (!['video', 'audio'].includes(media?.metadata?.mediaKind)) return failure(415, 'This stream route supports video and audio.');
      if (request.signal.aborted) return failure(400, 'Media request stopped.');
      const headers = new Headers();
      const range = request.headers.get('Range');
      if (range !== null) {
        if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return failure(400, 'Only one byte range is supported.');
        headers.set('Range', range);
      }
      const upstream = await fetchMedia(media.localAgentImageUrl, { method: 'GET', headers,
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: request.signal });
      if (![200, 206, 416].includes(upstream.status)) {
        await upstream.body?.cancel();
        log('Agent response unavailable', { status: upstream.status });
        return failure(upstream.status === 404 ? 404 : 502, 'The Local Agent could not stream this media.');
      }
      const outputHeaders = new Headers({ 'Content-Type': media.metadata.mimeType, 'Cache-Control': 'no-store' });
      for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges']) {
        const value = upstream.headers.get(name);
        if (value !== null) outputHeaders.set(name, value);
      }
      log('media response', { method: request.method, partial: range !== null, status: upstream.status });
      if (request.method === 'HEAD') await upstream.body?.cancel();
      // A fresh Response has no upstream HTTP URL. Its body remains the original
      // readable stream, including browser backpressure and cancellation.
      return new Response(request.method === 'HEAD' ? null : upstream.body,
        { status: upstream.status, headers: outputHeaders });
    } catch {
      log('media stream failed');
      return failure(502, 'The Local Agent media stream is unavailable.');
    }
  }
  return event => {
    let url;
    try { url = new URL(event.request.url); } catch { return; }
    if (!own(url) || url.pathname !== MEDIA_STREAM_ROUTE) return;
    // Register respondWith synchronously; all authorization and I/O follow in
    // the promise, so startup/suspension never require a persisted URL map.
    event.respondWith(respond(event, url));
  };
}
