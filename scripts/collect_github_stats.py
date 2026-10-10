#!/usr/bin/env python3
"""Collect daily, aggregate-only ResearchTube GitHub statistics.

Requires no third-party Python modules. GitHub traffic uses a separate,
read-only GH_TRAFFIC_STATS_TOKEN with repository Administration: read.
Other public metrics work with the automatically provided GITHUB_TOKEN.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

API = "https://api.github.com"
OUTPUT = Path(__file__).resolve().parent.parent / "stats" / "history.json"
MAX_RELEASE_PAGES = 20


def request_json(endpoint: str, token: str) -> object:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "ResearchTube-statistics-collector",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    request = Request(API + endpoint, headers=headers)
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def read_history() -> dict:
    if not OUTPUT.exists():
        return {
            "schema_version": 1,
            "traffic_days": {},
            "daily_snapshots": {},
        }
    with OUTPUT.open(encoding="utf-8") as stream:
        result = json.load(stream)
    if result.get("schema_version") != 1:
        raise ValueError("Unsupported GitHub statistics schema")
    if not isinstance(result.get("traffic_days"), dict) or not isinstance(
        result.get("daily_snapshots"), dict
    ):
        raise ValueError("Invalid GitHub statistics history")
    return result


def public_snapshot(repo: str, token: str) -> dict:
    info = request_json("/repos/" + repo, token)
    assert isinstance(info, dict)
    releases = []
    for page in range(1, MAX_RELEASE_PAGES + 1):
        batch = request_json(
            f"/repos/{repo}/releases?per_page=100&page={page}", token
        )
        if not isinstance(batch, list):
            raise ValueError("Expected list of releases")
        for release in batch:
            assets = []
            for asset in release.get("assets", []):
                assets.append(
                    {
                        "id": asset["id"],
                        "name": asset["name"],
                        "downloads": asset.get("download_count", 0),
                    }
                )
            releases.append(
                {
                    "tag": release.get("tag_name", ""),
                    "prerelease": bool(release.get("prerelease")),
                    "assets": assets,
                }
            )
        if len(batch) < 100:
            break
    else:
        raise ValueError("Too many GitHub Releases pages")
    return {
        "stars": info.get("stargazers_count", 0),
        "forks": info.get("forks_count", 0),
        "watchers": info.get("subscribers_count", 0),
        "releases": releases,
    }


def traffic_snapshot(repo: str, token: str, history: dict) -> dict:
    if not token:
        print(
            "::warning::GH_TRAFFIC_STATS_TOKEN is not configured. "
            "Views, clones, and referrers cannot be collected yet."
        )
        return {"status": "not_configured"}

    endpoints = {
        "views": f"/repos/{repo}/traffic/views?per=day",
        "clones": f"/repos/{repo}/traffic/clones?per=day",
        "referrers": f"/repos/{repo}/traffic/popular/referrers",
        "paths": f"/repos/{repo}/traffic/popular/paths",
    }
    results = {}
    for label, endpoint in endpoints.items():
        try:
            results[label] = request_json(endpoint, token)
        except (HTTPError, URLError, TimeoutError, ValueError) as error:
            code = getattr(error, "code", None)
            # Never print token, response body, or HTTP authorization headers.
            print(
                f"::warning::GitHub traffic {label} request unavailable "
                f"(HTTP {code if code is not None else 'network/error'})."
            )
            return {"status": "unavailable", "failed_endpoint": label}

    traffic = history["traffic_days"]
    for field in ("views", "clones"):
        block = results[field]
        if not isinstance(block, dict):
            raise ValueError("Expected traffic metrics object")
        for entry in block.get(field, []):
            day = entry["timestamp"][:10]
            daily = traffic.setdefault(day, {})
            daily[field] = int(entry.get("count", 0))
            daily[field + "_unique"] = int(entry.get("uniques", 0))
    return {
        "status": "ok",
        "referrers_14d": results["referrers"],
        "popular_paths_14d": results["paths"],
        "views_14d": {
            "count": results["views"].get("count", 0),
            "uniques": results["views"].get("uniques", 0),
        },
        "clones_14d": {
            "count": results["clones"].get("count", 0),
            "uniques": results["clones"].get("uniques", 0),
        },
    }


def main() -> None:
    repo = os.environ.get("GITHUB_REPOSITORY", "ilinic/ResearchTube")
    if repo != "ilinic/ResearchTube":
        raise ValueError("This collector is only intended for ilinic/ResearchTube")
    token = os.environ.get("GITHUB_TOKEN", "")
    traffic_token = os.environ.get("GH_TRAFFIC_STATS_TOKEN", "")
    today = datetime.now(timezone.utc).date().isoformat()

    history = read_history()
    snapshot = public_snapshot(repo, token)
    snapshot["traffic"] = traffic_snapshot(repo, traffic_token, history)
    history["daily_snapshots"][today] = snapshot

    # Every daily run also refreshes the past 14 days of traffic counts.
    # GitHub only retains that window, so keep our own historical copy.
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", encoding="utf-8") as stream:
        json.dump(history, stream, indent=2, sort_keys=True, ensure_ascii=False)
        stream.write("\n")

    print(
        f"Saved {today}: {snapshot['stars']} stars, "
        f"{len(snapshot['releases'])} releases, "
        f"traffic={snapshot['traffic']['status']}."
    )


if __name__ == "__main__":
    main()
