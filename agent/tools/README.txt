ResearchTube Local Agent tools folder

The Agent searches each dedicated local component folder first and then system
PATH. Keep only one usable candidate inside each dedicated component tree;
ambiguous discovery is reported as an error.

Typical Windows layouts:

  tools/yt-dlp/yt-dlp.exe
  tools/deno/deno.exe
  tools/ffmpeg/bin/ffmpeg.exe
  tools/ffmpeg/bin/ffprobe.exe
  tools/cloudflared/cloudflared.exe

FFmpeg may also be inside one extracted archive directory below tools/ffmpeg/,
for example tools/ffmpeg/ffmpeg-build/bin/ffmpeg.exe. Extract archives before
starting the Agent.

Current local YouTube yt-dlp operations require Deno and a ready BgUtils
PO-token provider. The provider files live under tools/youtube-pot-provider/
and its readiness is reported by the Agent. Tokens are generated locally per
video and are never stored in agent-config.json, printed in public diagnostics,
or returned through MCP.

Windows speech helpers live under tools/windows-speech/. Visual-map and
storyboard timestamp rendering uses the configured font under tools/fonts/.

Restart the Agent after adding or replacing a component. Use Extension Settings
or system_agent_status to confirm availability. MCP deliberately omits physical
paths; the selected local paths appear only in the Agent startup console.

See ../../docs/INSTALLATION.md and ../../docs/TROUBLESHOOTING.md.
