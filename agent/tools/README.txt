ResearchTube Local Agent tools folder

Place yt-dlp.exe directly in:
  tools/yt-dlp/yt-dlp.exe

Place Deno anywhere inside its dedicated folder, for example:
  tools/deno/deno.exe
  tools/deno/<extracted-folder>/deno.exe

When found, the Agent passes that exact Deno executable to yt-dlp as its
JavaScript runtime. Do not place more than one deno.exe under tools/deno.

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
