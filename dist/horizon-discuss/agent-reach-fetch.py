#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fetch URL via Agent Reach routing (Jina Reader + platform CLIs)."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from urllib.parse import urlparse

MAX_CHARS = 15000


def run(cmd: list[str], timeout: int = 60) -> str:
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "command failed").strip()
        raise RuntimeError(detail[:800])
    return (proc.stdout or "").strip()


def fetch_jina(url: str) -> tuple[str, str]:
    from agent_reach.channels.web import WebChannel

    return WebChannel().read(url), "Jina Reader (Agent Reach)"


def fetch_youtube(url: str) -> tuple[str, str]:
    if not shutil.which("yt-dlp"):
        raise RuntimeError("yt-dlp not installed")
    meta_json = run(["yt-dlp", "--dump-json", "--no-warnings", url], timeout=90)
    meta = json.loads(meta_json.splitlines()[0])
    title = meta.get("title") or "YouTube"
    desc = (meta.get("description") or "").strip()
    parts = [f"# {title}", "", desc]
    try:
        sub = run(
            [
                "yt-dlp",
                "--write-auto-sub",
                "--write-subs",
                "--sub-lang",
                "zh-Hans,zh,en",
                "--skip-download",
                "--print",
                "subtitle:%(title)s",
                url,
            ],
            timeout=120,
        )
        if sub:
            parts.extend(["", "## Subtitles", sub])
    except Exception:
        pass
    return "\n".join(parts).strip()[:MAX_CHARS], "yt-dlp (Agent Reach)"


def fetch_bilibili(url: str) -> tuple[str, str]:
    if shutil.which("bili"):
        try:
            return run(["bili", "video", url], timeout=90)[:MAX_CHARS], "bili-cli (Agent Reach)"
        except Exception:
            pass
    if shutil.which("opencli"):
        return (
            run(["opencli", "bilibili", "video", url, "-f", "yaml"], timeout=90)[:MAX_CHARS],
            "OpenCLI bilibili (Agent Reach)",
        )
    raise RuntimeError("no bilibili backend (install bili-cli or OpenCLI)")


def fetch_twitter(url: str) -> tuple[str, str]:
    if shutil.which("opencli"):
        try:
            return (
                run(["opencli", "twitter", "article", url, "-f", "yaml"], timeout=90)[:MAX_CHARS],
                "OpenCLI twitter (Agent Reach)",
            )
        except Exception:
            pass
    if shutil.which("twitter"):
        try:
            return run(["twitter", "read", url], timeout=90)[:MAX_CHARS], "twitter-cli (Agent Reach)"
        except Exception:
            pass
    raise RuntimeError("no twitter backend (install OpenCLI or twitter-cli)")


def fetch_rss(url: str) -> tuple[str, str]:
    import feedparser

    feed = feedparser.parse(url)
    lines = [f"# {feed.feed.get('title', 'RSS')}", ""]
    for entry in feed.entries[:10]:
        title = entry.get("title", "")
        link = entry.get("link", "")
        lines.append(f"- **{title}** — {link}")
        summary = entry.get("summary") or entry.get("description") or ""
        if summary:
            plain = re.sub(r"<[^>]+>", "", summary)
            lines.append(f"  {plain[:300]}")
    text = "\n".join(lines).strip()
    if not text:
        raise RuntimeError("empty RSS feed")
    return text[:MAX_CHARS], "feedparser (Agent Reach)"


def route(url: str) -> tuple[str, str]:
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    host = urlparse(url).netloc.lower()
    lowered = url.lower()

    if "youtube.com" in host or "youtu.be" in host:
        try:
            return fetch_youtube(url)
        except Exception:
            pass

    if "bilibili.com" in host or "b23.tv" in host:
        try:
            return fetch_bilibili(url)
        except Exception:
            pass

    if "twitter.com" in host or "x.com" in host:
        try:
            return fetch_twitter(url)
        except Exception:
            pass

    if any(x in lowered for x in ("/feed", "/rss", ".xml", "atom")):
        try:
            return fetch_rss(url)
        except Exception:
            pass

    return fetch_jina(url)


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "missing url"}))
        sys.exit(1)
    url = sys.argv[1].strip()
    try:
        text, backend = route(url)
        print(
            json.dumps(
                {"ok": True, "url": url, "backend": backend, "text": text},
                ensure_ascii=False,
            )
        )
    except Exception as exc:
        print(json.dumps({"ok": False, "url": url, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
