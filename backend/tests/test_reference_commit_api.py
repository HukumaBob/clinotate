"""POST /reference/runs/{id}/commit-episodes: the worked scenario and its edges."""

import json

import pytest
from fastapi.testclient import TestClient

import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
from app.annotation.models import Annotation
from app.inference.models import InferenceRunStatus
from app.main import app
from app.media.models import Frame, Sequence
from app.reference import commit as commit_module
from app.reference.commit import EpisodeSpan, ProcessedFrame, sample_frames
from app.storage import get_storage_service
from app.taxonomy.models import Label
from tests.test_qc_flags_api import FakeStorage, make_video
from tests.test_reference_evaluation_api import ANATOMY, _headers, world  # noqa: F401

client = TestClient(app)
VIDEO_KEY = "ref/e.mp4"


class Store(FakeStorage):
    """Fake storage that also serves the predictions documents of `world`."""

    def __init__(self, docs):
        super().__init__({VIDEO_KEY: make_video()})
        self.docs = docs

    def download(self, key):
        if key in self.docs:
            return json.dumps(self.docs[key]).encode()
        return super().download(key)

    def uploaded(self):
        return sorted(k for k in self.objects if k.startswith("frames/"))


@pytest.fixture
def store(world):  # noqa: F811
    storage = Store(world.docs)
    app.dependency_overrides[get_storage_service] = lambda: storage
    yield storage


def make_doc_every(step_ms, predicted):
    """Anatomy classification document: frame i at i * step_ms, predicted[i] a class name."""
    return {
        "task_type": "classification",
        "axes": [{"name": "Anatomy", "classes": ANATOMY}],
        "frames": {
            str(i): {
                "timestamp_ms": i * step_ms,
                "axes": [{"class_id": ANATOMY.index(p), "confidence": 0.9, "probs": []}],
            }
            for i, p in enumerate(predicted)
        },
    }


# Frames every 500 ms, 0..10000. Episode A = rectum at 2000..3000, B = colon_left at 3500..4000.
SCENARIO_PRED = (
    ["caecum"] * 4 + ["rectum"] * 3 + ["colon_left"] * 2 + ["caecum"] * 12
)


def scenario(world, predicted=SCENARIO_PRED, step_ms=500, status=InferenceRunStatus.SUCCEEDED):  # noqa: F811
    procedure_id, axes = world.make_procedure(
        {"Anatomy": ANATOMY, "Quality": ["good_quality", "bad_quality"]}
    )
    cat, labels = axes["Anatomy"]
    qcat, qlabels = axes["Quality"]
    video_id = world.make_video(
        procedure_id,
        [(cat, labels["caecum"], 0, 4200), (qcat, qlabels["good_quality"], 2200, 3800)],
    )
    run_id = world.make_run(video_id, make_doc_every(step_ms, predicted), status=status)
    return video_id, run_id, labels, qlabels


def set_label(label_id, **fields):
    session = db_module.SessionLocal()
    try:
        label = session.get(Label, label_id)
        for key, value in fields.items():
            setattr(label, key, value)
        session.commit()
    finally:
        session.close()


def post(run_id, **body):
    return client.post(f"/reference/runs/{run_id}/commit-episodes", headers=_headers(), json=body)


A = {"axis": "Anatomy", "start_ms": 2000}
B = {"axis": "Anatomy", "start_ms": 3500}


def rows_of(video_id):
    session = db_module.SessionLocal()
    try:
        sequences = session.query(Sequence).filter(Sequence.video_id == video_id).all()
        ids = [s.id for s in sequences]
        frames = session.query(Frame).filter(Frame.sequence_id.in_(ids)).all() if ids else []
        frame_ids = [f.id for f in frames]
        anns = (
            session.query(Annotation).filter(Annotation.frame_id.in_(frame_ids)).all()
            if frame_ids else []
        )
        return sequences, frames, anns
    finally:
        session.close()


@pytest.fixture(autouse=True)
def _cleanup_sequences(world):  # noqa: F811
    yield
    session = db_module.SessionLocal()
    try:
        from app.media.models import Video

        ids = [v.id for v in session.query(Video).filter(Video.title == "refeval")]
        seq_ids = [s.id for s in session.query(Sequence).filter(Sequence.video_id.in_(ids))]
        frame_ids = [f.id for f in session.query(Frame).filter(Frame.sequence_id.in_(seq_ids))]
        session.query(Annotation).filter(Annotation.frame_id.in_(frame_ids)).delete(
            synchronize_session=False
        )
        session.query(Frame).filter(Frame.id.in_(frame_ids)).delete(synchronize_session=False)
        session.query(Sequence).filter(Sequence.id.in_(seq_ids)).delete(synchronize_session=False)
        session.commit()
    finally:
        session.close()


def test_worked_scenario_end_to_end(world, store):  # noqa: F811
    video_id, run_id, labels, qlabels = scenario(world)
    response = post(run_id, episodes=[A, B])
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["dry_run"] is False
    assert (body["episodes"], body["frames"], body["dropped_unlabeled"]) == (2, 6, 1)
    assert body["annotations_by_axis"] == {"Anatomy": 6, "Quality": 3}
    assert body["sequence_name"].startswith("QC errors · refeval · run #%d · " % run_id)

    sequences, frames, anns = rows_of(video_id)
    (sequence,) = sequences
    assert sequence.id == body["sequence_id"]
    assert (sequence.start_time, sequence.duration) == (1, 3)
    assert sequence.origin_qc_run_id == run_id
    frames.sort(key=lambda f: f.frame_index)
    assert len(frames) == 6 and len(store.uploaded()) == 6
    assert all(f.no_findings_reviewed is False for f in frames)

    session = db_module.SessionLocal()
    try:
        versions = {l.id: l.taxonomy_version for l in session.query(Label)}
    finally:
        session.close()
    # frame positions 0..5 are ts 1000, 2000, 2500, 3000, 3500, 4000
    by_frame = {f.id: i for i, f in enumerate(frames)}
    got = {}
    for ann in anns:
        got.setdefault(by_frame[ann.frame_id], set()).add(ann.label_id)
        assert ann.taxonomy_version == versions[ann.label_id]
        assert ann.payload == {} and ann.annotation_type.value == "classification"
    caecum, good = labels["caecum"], qlabels["good_quality"]
    assert got == {
        0: {caecum}, 1: {caecum}, 2: {caecum, good}, 3: {caecum, good},
        4: {caecum, good}, 5: {caecum},
    }
    assert len(anns) == 9


def test_dry_run_returns_the_same_counts_and_writes_nothing(world, store):  # noqa: F811
    video_id, run_id, *_ = scenario(world)
    response = post(run_id, episodes=[A, B], dry_run=True)
    assert response.status_code == 200
    body = response.json()
    assert body["dry_run"] is True
    assert (body["episodes"], body["frames"], body["dropped_unlabeled"]) == (2, 6, 1)
    assert body["annotations_by_axis"] == {"Anatomy": 6, "Quality": 3}
    assert body["sequence_id"] is None and body["sequence_name"] is None
    sequences, frames, anns = rows_of(video_id)
    assert not sequences and not frames and not anns
    assert store.uploaded() == [] and store.uploads == 0


def test_overlapping_episodes_give_no_duplicate_frame(world, store):  # noqa: F811
    video_id, run_id, *_ = scenario(world)
    body = post(
        run_id, episodes=[A, B, A], step_ms=500, margin_ms=2000, dry_run=True
    ).json()
    # instants 0..6000 every 500 -> 13 distinct frames; ts < 4200 (9) are kept, 4 dropped
    assert body["episodes"] == 2 and body["frames"] == 9 and body["dropped_unlabeled"] == 4


def test_name_given_and_default(world, store):  # noqa: F811
    video_id, run_id, *_ = scenario(world)
    body = post(run_id, episodes=[A], name="my errors").json()
    assert body["sequence_name"] == "my errors"
    body = post(run_id, episodes=[B]).json()
    assert body["sequence_name"].startswith("QC errors · refeval · run #")


def test_unknown_axis_and_stale_start_are_422(world, store):  # noqa: F811
    video_id, run_id, *_ = scenario(world)
    assert post(run_id, episodes=[{"axis": "Nope", "start_ms": 2000}]).status_code == 422
    assert post(run_id, episodes=[{"axis": "Anatomy", "start_ms": 2001}]).status_code == 422
    assert post(run_id, episodes=[A, {"axis": "Anatomy", "start_ms": 1}]).status_code == 422
    sequences, _, _ = rows_of(video_id)
    assert not sequences


def test_bounds_are_422(world, store):  # noqa: F811
    _, run_id, *_ = scenario(world)
    assert post(run_id, episodes=[]).status_code == 422
    assert post(run_id, episodes=[A], step_ms=99).status_code == 422
    assert post(run_id, episodes=[A], step_ms=60001).status_code == 422
    assert post(run_id, episodes=[A], margin_ms=60001).status_code == 422
    assert post(run_id, episodes=[A], margin_ms=-1).status_code == 422
    assert post(run_id, episodes=[A], name="x" * 256).status_code == 422


def test_cap_is_enforced_before_any_cut(world, store, monkeypatch):  # noqa: F811
    from app.inference import service as inference_service

    def boom(*args, **kwargs):
        raise AssertionError("frames must not be cut")

    monkeypatch.setattr(inference_service, "extract_frames_at", boom)
    procedure_id, axes = world.make_procedure({"Anatomy": ANATOMY})
    cat, labels = axes["Anatomy"]
    video_id = world.make_video(procedure_id, [(cat, labels["caecum"], 0, 400000)])
    run_id = world.make_run(video_id, make_doc_every(100, ["rectum"] * 600))
    episode = {"axis": "Anatomy", "start_ms": 0}
    response = post(run_id, episodes=[episode], step_ms=100, margin_ms=0)
    assert response.status_code == 422
    assert "600 frames" in response.json()["detail"] and "500" in response.json()["detail"]
    assert store.uploads == 0


def test_all_unlabeled_is_422(world, store):  # noqa: F811
    procedure_id, axes = world.make_procedure({"Anatomy": ANATOMY})
    cat, labels = axes["Anatomy"]
    video_id = world.make_video(procedure_id, [(cat, labels["caecum"], 1000, 1600)])
    # frames at 900 (outside the reference) and 1500 (the only scored, wrong frame)
    doc = make_doc_every(500, ["caecum", "rectum", "caecum"])
    for key, ts in zip(("0", "1", "2"), (900, 1500, 4000)):
        doc["frames"][key]["timestamp_ms"] = ts
    run_id = world.make_run(video_id, doc)
    # the one instant is 1500 itself, covered only by an abstract label
    set_label(labels["caecum"], is_abstract=True)
    response = post(run_id, episodes=[{"axis": "Anatomy", "start_ms": 1500}], margin_ms=300)
    assert response.status_code == 422
    assert "No frame left" in response.json()["detail"]
    sequences, _, _ = rows_of(video_id)
    assert not sequences


def test_run_states(world, store):  # noqa: F811
    assert post(999999999, episodes=[A]).status_code == 404
    _, pending, *_ = scenario(world, status=InferenceRunStatus.PENDING)
    assert post(pending, episodes=[A]).status_code == 409
    procedure_id, axes = world.make_procedure({"Anatomy": ANATOMY})
    cat, labels = axes["Anatomy"]
    video_id = world.make_video(procedure_id, [(cat, labels["caecum"], 0, 1000)])
    detection = world.make_run(video_id, {"task_type": "detection", "frames": {}})
    assert post(detection, episodes=[A]).status_code == 409
    bare_video = world.make_video(procedure_id)
    bare = world.make_run(bare_video, make_doc_every(500, SCENARIO_PRED))
    assert post(bare, episodes=[A]).status_code == 409


def test_failure_after_upload_leaves_nothing(world, store, monkeypatch):  # noqa: F811
    video_id, run_id, *_ = scenario(world)

    def broken(**kwargs):
        raise RuntimeError("insert failed")

    monkeypatch.setattr(commit_module, "Annotation", broken)
    with pytest.raises(RuntimeError, match="insert failed"):
        client.post(
            f"/reference/runs/{run_id}/commit-episodes",
            headers=_headers(), json={"episodes": [A, B]},
        )
    sequences, frames, anns = rows_of(video_id)
    assert not sequences and not frames and not anns
    assert store.uploads == 6 and store.uploaded() == []


def test_sample_frames_rejects_a_non_positive_step():
    frames = [ProcessedFrame(0, 0)]
    for step in (0, -100):
        with pytest.raises(ValueError):
            sample_frames([EpisodeSpan("a", 0, 10)], frames, step, 0)


def test_abstract_labels_do_not_cover(world, store):  # noqa: F811
    video_id, run_id, labels, qlabels = scenario(world)
    # caecum abstract: only frames under good_quality (2500, 3000, 3500) stay
    set_label(labels["caecum"], is_abstract=True)
    body = post(run_id, episodes=[A, B], dry_run=True).json()
    assert (body["frames"], body["dropped_unlabeled"]) == (3, 4)
    assert body["annotations_by_axis"] == {"Quality": 3}
    # good_quality abstract instead: the 6 frames keep only their caecum annotation
    set_label(labels["caecum"], is_abstract=False)
    set_label(qlabels["good_quality"], is_abstract=True)
    response = post(run_id, episodes=[A, B])
    assert response.status_code == 201, response.text
    assert response.json()["annotations_by_axis"] == {"Anatomy": 6}
    _, frames, anns = rows_of(video_id)
    assert len(frames) == 6 and len(anns) == 6
    assert {a.label_id for a in anns} == {labels["caecum"]}


def test_taxonomy_version_is_the_labels_current_one(world, store):  # noqa: F811
    video_id, run_id, labels, qlabels = scenario(world)
    set_label(labels["caecum"], taxonomy_version=7)  # the interval itself says 1
    assert post(run_id, episodes=[A, B]).status_code == 201
    _, _, anns = rows_of(video_id)
    caecum = [a for a in anns if a.label_id == labels["caecum"]]
    assert len(caecum) == 6 and all(a.taxonomy_version == 7 for a in caecum)
    assert all(a.taxonomy_version == 1 for a in anns if a.label_id != labels["caecum"])


def test_orphaned_interval_never_labels_a_frame(world, store):  # noqa: F811
    procedure_id, axes = world.make_procedure(
        {"Anatomy": ANATOMY, "Quality": ["good_quality", "bad_quality"]}
    )
    cat, labels = axes["Anatomy"]
    qcat, qlabels = axes["Quality"]
    video_id = world.make_video(
        procedure_id,
        [
            (cat, labels["caecum"], 0, 4200),
            (qcat, qlabels["good_quality"], 2200, 3800),
            (qcat, qlabels["bad_quality"], 4200, 5000),  # covers only 4500
        ],
    )
    run_id = world.make_run(video_id, make_doc_every(500, SCENARIO_PRED))
    assert post(run_id, episodes=[A, B], dry_run=True).json()["frames"] == 7
    _, other = world.make_procedure({"Elsewhere": ["q"]})
    set_label(qlabels["bad_quality"], category_id=other["Elsewhere"][0])  # orphaned
    body = post(run_id, episodes=[A, B]).json()
    assert (body["frames"], body["dropped_unlabeled"]) == (6, 1)
    _, _, anns = rows_of(video_id)
    assert qlabels["bad_quality"] not in {a.label_id for a in anns}


def test_start_time_and_duration_use_the_earliest_and_latest_timestamp(world, store):  # noqa: F811
    procedure_id, axes = world.make_procedure({"Anatomy": ANATOMY})
    cat, labels = axes["Anatomy"]
    video_id = world.make_video(procedure_id, [(cat, labels["caecum"], 0, 4200)])
    doc = make_doc_every(500, SCENARIO_PRED)
    # frame numbers run backwards in time: frame order is not timestamp order
    doc["frames"] = {str(20 - int(k)): v for k, v in doc["frames"].items()}
    run_id = world.make_run(video_id, doc)
    response = post(run_id, episodes=[A, B])
    assert response.status_code == 201, response.text
    (sequence,), _, _ = rows_of(video_id)
    assert (sequence.start_time, sequence.duration) == (1, 3)


def test_negative_frame_numbers_are_never_sampled(world, store):  # noqa: F811
    procedure_id, axes = world.make_procedure({"Anatomy": ANATOMY})
    cat, labels = axes["Anatomy"]
    video_id = world.make_video(procedure_id, [(cat, labels["caecum"], 0, 4200)])
    doc = make_doc_every(500, SCENARIO_PRED)
    doc["frames"]["-2"] = doc["frames"].pop("2")  # the frame at 1000 ms
    run_id = world.make_run(video_id, doc)
    response = post(run_id, episodes=[A, B])
    assert response.status_code == 201, response.text
    # instant 1000 falls back to the frame at 500 ms (tie to the lower one)
    assert response.json()["frames"] == 6
    _, frames, _ = rows_of(video_id)
    assert len(frames) == 6


def test_ambiguous_axis_name_is_422(world, store):  # noqa: F811
    video_id, _, *_ = scenario(world)
    doc = make_doc_every(500, SCENARIO_PRED)
    doc["axes"] = [{"name": "Anatomy", "classes": ANATOMY}] * 2
    for frame in doc["frames"].values():
        frame["axes"] = frame["axes"] * 2
    run_id = world.make_run(video_id, doc)
    response = post(run_id, episodes=[A], dry_run=True)
    assert response.status_code == 422
    assert "ambiguous" in response.json()["detail"].lower()


def test_blank_name_gets_the_default_and_a_name_is_stripped(world, store):  # noqa: F811
    _, run_id, *_ = scenario(world)
    body = post(run_id, episodes=[A], name="   ").json()
    assert body["sequence_name"].startswith("QC errors · refeval · run #")
    body = post(run_id, episodes=[B], name="  my errors  ").json()
    assert body["sequence_name"] == "my errors"


def test_openapi_declares_both_the_201_commit_and_the_200_dry_run():
    responses = app.openapi()["paths"]["/reference/runs/{run_id}/commit-episodes"]["post"][
        "responses"
    ]
    for code in ("200", "201"):
        schema = responses[code]["content"]["application/json"]["schema"]
        assert schema == {"$ref": "#/components/schemas/CommitEpisodesRead"}


def test_episode_frames_are_cut_with_the_runs_working_area(world, store):  # noqa: F811
    from app.inference.models import InferenceRun

    video_id, run_id, _labels, _qlabels = scenario(world)
    crop = {"left": 25, "right": 0, "top": 0, "bottom": 0}
    session = db_module.SessionLocal()
    try:
        session.get(InferenceRun, run_id).crop_box = crop
        session.commit()
    finally:
        session.close()

    assert post(run_id, episodes=[A, B]).status_code == 201

    (sequence,), frames, _ = rows_of(video_id)
    assert sequence.crop_box == crop
    assert {(f.width, f.height) for f in frames} == {(48, 48)}
