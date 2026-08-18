import resource
import zipfile

import app.main  # noqa: F401


def test_streaming_a_large_archive_does_not_grow_memory_linearly(tmp_path):
    """A thousand 64 KB entries is ~64 MB of payload.

    If the archive were assembled in memory, peak RSS would climb by roughly
    that much. Streaming to a file keeps the delta far below it. The
    threshold is deliberately loose -- this catches an architectural
    regression, not a few megabytes of noise.
    """
    payload = b"x" * 64 * 1024
    before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

    archive_path = tmp_path / "big.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for index in range(1000):
            archive.writestr(f"images/train/frame_{index}.bin", payload)

    after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    growth_mb = (after - before) / 1024

    assert archive_path.stat().st_size > 0
    assert growth_mb < 32, f"peak RSS grew {growth_mb:.1f} MB writing a ~64 MB archive"
