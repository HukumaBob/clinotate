from __future__ import annotations

import re
import subprocess
import threading
from collections.abc import Callable, Sequence

_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")


def parse_progress_line(line: str) -> tuple[str, str] | None:
    """Parse one line of ffmpeg `-progress pipe:1` output into a (key, value) pair."""
    stripped = line.strip()
    if not stripped or "=" not in stripped:
        return None
    key, _, value = stripped.partition("=")
    return key, value


def parse_duration_from_stderr_line(line: str) -> float | None:
    """Extract the source duration in seconds from ffmpeg's stderr banner line.

    ffmpeg prints e.g. "Duration: 00:01:23.45, start: 0.000000, bitrate: ..."
    on stderr as soon as it opens the input, regardless of whether the
    codec is one our own metadata probe (OpenCV) can decode -- this is the
    fallback duration source for videos whose codec is unsupported enough
    that OpenCV couldn't populate `duration_seconds` at upload time.
    """
    match = _DURATION_RE.search(line)
    if match is None:
        return None
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def run_ffmpeg_with_progress(
    args: Sequence[str],
    duration_seconds: float,
    on_progress: Callable[[int], None],
    timeout: float,
) -> None:
    """Run ffmpeg, invoking on_progress(percent) as -progress pipe:1 reports out_time_ms.

    `args` must not include `-progress`; it is appended here. If
    `duration_seconds` is not yet known (<= 0), it is recovered from
    ffmpeg's own stderr "Duration:" banner instead of skipping progress
    reporting entirely.
    """
    full_args = [*args, "-progress", "pipe:1", "-nostats"]
    process = subprocess.Popen(
        full_args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    assert process.stderr is not None

    known_duration = duration_seconds if duration_seconds > 0 else None

    def drain_stderr() -> None:
        nonlocal known_duration
        for line in process.stderr:
            if known_duration is None:
                parsed = parse_duration_from_stderr_line(line)
                if parsed is not None:
                    known_duration = parsed

    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stderr_thread.start()

    try:
        for line in process.stdout:
            parsed = parse_progress_line(line)
            if parsed is None:
                continue
            key, value = parsed
            if key != "out_time_ms":
                continue
            if not known_duration:
                # Source has no discoverable duration (e.g. a raw/streamed
                # container ffprobe itself reports as "Duration: N/A") --
                # signal "in progress, percentage unknown" rather than
                # silently reporting nothing.
                on_progress(-1)
                continue
            try:
                out_time_seconds = int(value) / 1_000_000
            except ValueError:
                continue
            percent = int(min(99, max(0, (out_time_seconds / known_duration) * 100)))
            on_progress(percent)
        returncode = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        raise
    finally:
        stderr_thread.join(timeout=5)

    if returncode != 0:
        raise subprocess.CalledProcessError(returncode, full_args)
