ResearchTube Local Agent tools folder

Place yt-dlp.exe directly in:
  tools/yt-dlp/yt-dlp.exe

Place Deno anywhere inside its dedicated folder, for example:
  tools/deno/deno.exe
  tools/deno/<extracted-folder>/deno.exe

When found, the Agent passes that exact Deno executable to yt-dlp as its
JavaScript runtime. Do not place more than one deno.exe under tools/deno.

The YouTube PO-token provider is mandatory for local YouTube operations. Run
from the agent directory:
  powershell -ExecutionPolicy Bypass -File .\install-youtube-po-token-provider.ps1

It installs the bgutil-ytdlp-pot-provider plugin under tools/yt-dlp and its
local Deno generator under tools/youtube-pot-provider. Restart the Agent after
installation. The Agent reports the provider's version and readiness during
startup. Tokens are generated locally per video and are never saved in
agent-config.json, printed in Agent logs, or exposed through MCP.

The installer automatically approves the one currently required Deno build
script, npm:@swc/core. If repairing an older partial installation manually,
run this exact command from tools/youtube-pot-provider/server:
  <path-to-deno.exe> approve-scripts npm:@swc/core
Then run the installer again; do not approve every pending package globally.

Extract an FFmpeg archive under:
  tools/ffmpeg/

The Agent recognises either of these FFmpeg layouts:
  tools/ffmpeg/bin/ffmpeg.exe
  tools/ffmpeg/<extracted-archive-folder>/bin/ffmpeg.exe

ffprobe.exe normally belongs in that same bin folder. Do not place the ZIP
archive here without extracting it. Restart the Local Agent after adding or
replacing a tool, then use researchtube_agent_status to confirm availability.
MCP deliberately does not expose physical paths; those are printed only in
the Agent console at startup.
