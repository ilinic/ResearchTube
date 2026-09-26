# cloudflared

Place the Cloudflare `cloudflared` executable here (or in a nested extracted
archive). The Local Agent prefers this folder over `PATH`, verifies it with
`cloudflared --version`, and starts a no-account Quick Tunnel only for its
separate loopback image server.

The Agent does not tunnel its localhost API. Quick Tunnel hostnames are random
and live only while the Agent process is running.
