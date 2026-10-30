"""Pure checks for model_train that never open a database session."""

import app.tasks as tasks


def test_model_train_evicts_every_resident_model_before_any_gpu_work(monkeypatch):
    calls = []
    for name in (
        "_evict_sam3_models",
        "_evict_sam2_models",
        "_evict_quality_models",
        "_evict_similarity_models",
    ):
        monkeypatch.setattr(tasks, name, lambda n=name: calls.append(n))

    class _NoJobSession:
        def get(self, *_args):
            return None

        def close(self):
            pass

    monkeypatch.setattr(tasks, "SessionLocal", lambda: _NoJobSession())

    tasks.model_train(1)

    assert sorted(calls) == [
        "_evict_quality_models",
        "_evict_sam2_models",
        "_evict_sam3_models",
        "_evict_similarity_models",
    ]


def test_version_name_for_a_yolo_start_drops_the_extension():
    assert tasks.version_name_for("yolo11n.pt", 7, fine_tune=False) == "yolo11n-run7"


def test_version_name_for_a_hub_id_drops_the_org_prefix():
    name = tasks.version_name_for("facebook/dinov3-vitb16-pretrain-lvd1689m", 9, fine_tune=False)
    assert name == "dinov3-vitb16-pretrain-lvd1689m-run9"


def test_version_name_for_a_fine_tune_keeps_the_parent_name():
    assert tasks.version_name_for("yolo11n-run7", 8, fine_tune=True) == "yolo11n-run7-ft-run8"


def test_version_name_for_a_long_parent_is_trimmed_not_the_suffix():
    name = tasks.version_name_for("p" * 300, 12, fine_tune=True)
    assert len(name) == 200 and name.endswith("-ft-run12")
