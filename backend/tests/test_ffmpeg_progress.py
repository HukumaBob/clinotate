from app.worker.ffmpeg_progress import (
    parse_duration_from_stderr_line,
    parse_progress_line,
    run_ffmpeg_with_progress,
)


def test_parse_progress_line_returns_out_time_ms_for_matching_key():
    assert parse_progress_line("out_time_ms=1500000") == ("out_time_ms", "1500000")


def test_parse_progress_line_returns_none_for_blank_line():
    assert parse_progress_line("") is None


def test_parse_progress_line_returns_none_for_line_without_equals():
    assert parse_progress_line("progress") is None


def test_parse_progress_line_strips_whitespace():
    assert parse_progress_line("  progress=continue  \n") == ("progress", "continue")


def test_parse_duration_from_stderr_line_extracts_seconds():
    line = "  Duration: 00:01:23.45, start: 0.000000, bitrate: 5000 kb/s"
    assert parse_duration_from_stderr_line(line) == 83.45


def test_parse_duration_from_stderr_line_handles_hours():
    line = "  Duration: 01:02:03.00, start: 0.000000, bitrate: 5000 kb/s"
    assert parse_duration_from_stderr_line(line) == 3723.0


def test_parse_duration_from_stderr_line_returns_none_for_unrelated_line():
    assert parse_duration_from_stderr_line("frame=  120 fps= 30") is None


def test_run_ffmpeg_with_progress_reports_negative_one_when_duration_unknowable():
    # tiny_no_duration.mjpeg is a raw MJPEG stream with no container
    # duration header -- ffmpeg itself prints "Duration: N/A" for it, so
    # neither our caller-supplied duration_seconds nor the stderr fallback
    # can resolve a real duration.
    observed: list[int] = []

    run_ffmpeg_with_progress(
        [
            "ffmpeg", "-y",
            "-i", "tests/fixtures/tiny_no_duration.mjpeg",
            "-c:v", "libx264",
            "-f", "mp4",
            "/tmp/test_run_ffmpeg_with_progress_output.mp4",
        ],
        duration_seconds=0,
        on_progress=observed.append,
        timeout=30,
    )

    assert observed, "expected at least one progress callback"
    assert all(p == -1 for p in observed)


def test_run_ffmpeg_with_progress_computes_percent_when_duration_known():
    observed: list[int] = []

    run_ffmpeg_with_progress(
        [
            "ffmpeg", "-y",
            "-i", "tests/fixtures/tiny.mp4",
            "-c:v", "libx264",
            "-f", "mp4",
            "/tmp/test_run_ffmpeg_with_progress_output2.mp4",
        ],
        duration_seconds=2.0,
        on_progress=observed.append,
        timeout=30,
    )

    assert observed, "expected at least one progress callback"
    assert all(0 <= p <= 99 for p in observed)
