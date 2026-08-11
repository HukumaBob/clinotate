def test_platform_settings_model_has_default_max_track_range_frames():
    from app.settings.models import PlatformSettings

    row = PlatformSettings()
    assert row.max_track_range_frames == 10


def test_platform_settings_model_has_default_mask_postprocess_strength():
    from app.settings.models import PlatformSettings

    row = PlatformSettings()
    assert row.mask_postprocess_strength == 0.3
