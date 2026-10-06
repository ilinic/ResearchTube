# Bundled time-zone data

`zoneinfo.zip` contains the TZif files from the Python core team's `tzdata` package, version 2026.4. Timers read these files with standard-library `ZoneInfo`, including on Windows without installing packages.

Upstream: https://github.com/python/tzdata

License: see [LICENSE](LICENSE). Regenerate the archive from an updated official tzdata distribution when time-zone rules change; preserve zone-relative paths.
