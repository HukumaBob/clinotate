from app.celery_app import celery_app


def test_celery_app_uses_redis_broker_from_settings():
    from app.config import get_settings

    settings = get_settings()
    assert celery_app.conf.broker_url == settings.redis_url


def test_celery_app_result_backend_is_redis():
    from app.config import get_settings

    settings = get_settings()
    assert celery_app.conf.result_backend == settings.redis_url
