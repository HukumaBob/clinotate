"""The two pieces the error-episode commit shares with existing features:
the evaluation context loader and the frame-storing helper."""

import cv2
import numpy as np
import pytest

import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
from app.inference import service as inference_service
from app.inference.models import InferenceRunStatus
from app.media.models import Frame, Sequence, Video
from app.reference import service as reference_service
from app.reference.commit import RefInterval
from tests.test_qc_flags_api import FakeStorage, make_video
from tests.test_reference_evaluation_api import (  # noqa: F401 -- world is a fixture
    ANATOMY,
    PREDICTIONS,
    _scenario,
    _Storage,
    make_doc,
    world,
)

VIDEO_KEY = "videos/inference-playable.mp4"


# --- store_frames_as_sequence -------------------------------------------------


def _store(session, storage, video_id, frame_numbers, on_frame=None, name="helper-seq"):
    video = session.get(Video, video_id)
    return inference_service.store_frames_as_sequence(
        session,
        storage,
        video=video,
        name=name,
        start_time=0,
        duration=3,
        origin_qc_run_id=None,
        frame_numbers=frame_numbers,
        on_frame=on_frame or (lambda position, frame: None),
    )


def _sequences_of(video_id):
    session = db_module.SessionLocal()
    try:
        return session.query(Sequence).filter(Sequence.video_id == video_id).all()
    finally:
        session.close()


def _frame_objects(storage):
    return sorted(key for key in storage.objects if key.startswith("frames/"))


def test_the_helper_stores_frames_in_order_and_calls_on_frame(committed_inference_rows):
    rows = committed_inference_rows
    storage = FakeStorage({VIDEO_KEY: make_video()})
    calls = []
    session = db_module.SessionLocal()
    try:
        sequence = _store(
            session, storage, rows.video_id, [3, 12, 20],
            on_frame=lambda position, frame: calls.append((position, frame.id, frame.frame_index)),
        )
        sequence_id = sequence.id
        assert sequence.name == "helper-seq"
        assert (sequence.start_time, sequence.duration) == (0, 3)
        assert sequence.video_id == rows.video_id
    finally:
        session.close()

    # on_frame sees every frame, in order, with its id already assigned
    assert [(p, i) for p, _, i in calls] == [(0, 0), (1, 1), (2, 2)]
    assert all(frame_id is not None for _, frame_id, _ in calls)

    session = db_module.SessionLocal()
    try:
        frames = (
            session.query(Frame).filter(Frame.sequence_id == sequence_id)
            .order_by(Frame.frame_index).all()
        )
        assert [f.storage_key for f in frames] == [
            f"frames/{sequence_id}/{p}.png" for p in range(3)
        ]
        assert [f.id for f in frames] == [frame_id for _, frame_id, _ in calls]
        # the frame content names its source frame number (gray = number * 8)
        grays = [
            int(cv2.imdecode(np.frombuffer(storage.objects[f.storage_key], np.uint8),
                             cv2.IMREAD_COLOR).mean())
            for f in frames
        ]
        assert [round(g / 8) for g in grays] == [3, 12, 20]
        assert (frames[0].width, frames[0].height) == (64, 48)
    finally:
        session.close()


def test_a_failure_inside_on_frame_leaves_nothing(committed_inference_rows):
    rows = committed_inference_rows
    storage = FakeStorage({VIDEO_KEY: make_video()})

    def boom(position, frame):
        if position == 1:
            raise RuntimeError("caller failed")

    session = db_module.SessionLocal()
    try:
        with pytest.raises(RuntimeError, match="caller failed"):
            _store(session, storage, rows.video_id, [0, 5, 10], on_frame=boom)
    finally:
        session.close()
    assert storage.uploads == 3
    assert _frame_objects(storage) == []
    assert _sequences_of(rows.video_id) == []


def test_a_failure_at_commit_leaves_nothing(committed_inference_rows):
    rows = committed_inference_rows
    storage = FakeStorage({VIDEO_KEY: make_video()})
    session = db_module.SessionLocal()
    original_commit = session.commit

    def failing_commit():
        raise RuntimeError("database down")

    session.commit = failing_commit
    try:
        with pytest.raises(RuntimeError, match="database down"):
            _store(session, storage, rows.video_id, [0, 5])
    finally:
        session.commit = original_commit
        session.close()
    assert storage.uploads == 2
    assert _frame_objects(storage) == []
    assert _sequences_of(rows.video_id) == []


def test_frames_past_the_end_raise_and_create_nothing(committed_inference_rows):
    rows = committed_inference_rows
    storage = FakeStorage({VIDEO_KEY: make_video(frames=30)})
    session = db_module.SessionLocal()
    try:
        with pytest.raises(inference_service.FramesPastEnd) as info:
            _store(session, storage, rows.video_id, [5, 40])
    finally:
        session.close()
    assert info.value.indices == [40]
    assert storage.uploads == 0
    assert _sequences_of(rows.video_id) == []


@pytest.mark.parametrize("numbers", [[12, 3], [3, 3]])
def test_frame_numbers_must_be_distinct_and_ascending(committed_inference_rows, numbers):
    rows = committed_inference_rows
    storage = FakeStorage({VIDEO_KEY: make_video()})
    session = db_module.SessionLocal()
    try:
        with pytest.raises(RuntimeError, match="do not match"):
            _store(session, storage, rows.video_id, numbers)
    finally:
        session.close()
    assert storage.uploads == 0
    assert _sequences_of(rows.video_id) == []


def test_an_unreadable_video_raises_and_creates_nothing(committed_inference_rows):
    rows = committed_inference_rows
    storage = FakeStorage({VIDEO_KEY: b"definitely not a video"})
    session = db_module.SessionLocal()
    try:
        with pytest.raises(inference_service.VideoUnreadable):
            _store(session, storage, rows.video_id, [0])
    finally:
        session.close()
    assert storage.uploads == 0
    assert _sequences_of(rows.video_id) == []


# --- load_run_eval_context ----------------------------------------------------


def _load(world, run_id):
    session = db_module.SessionLocal()
    try:
        return reference_service.load_run_eval_context(session, _Storage(world.docs), run_id)
    finally:
        session.close()


def test_the_context_of_the_worked_scenario(world):
    video_id, run_id, cat = _scenario(world)
    context = _load(world, run_id)

    assert context.run.id == run_id and context.video.id == video_id
    assert context.reference.video_id == video_id
    assert context.document["axes"][0]["name"] == "Anatomy"
    (axis,) = context.axes
    assert axis.name == "Anatomy" and axis.classes == ANATOMY
    assert axis.reference_axis == 0
    assert context.reference.axes[axis.reference_axis].category_id == cat
    assert axis.frame_indices == list(range(12))
    assert [f.ts_ms for f in axis.frames] == [i * 1000 for i in range(12)]
    assert [f.predicted for f in axis.frames] == [p for p, _ in PREDICTIONS]
    assert axis.invalid == 0
    assert [(i.start_ms, i.end_ms, i.label) for i in axis.intervals] == [
        (0, 3000, "caecum"), (3000, 6000, "colon_left"), (8000, 10000, "colon_left"),
    ]
    labels = {c.name: c.label_id for c in context.reference.axes[0].classes}
    assert context.reference_intervals == [
        RefInterval(cat, labels["caecum"], 0, 3000),
        RefInterval(cat, labels["colon_left"], 3000, 6000),
        RefInterval(cat, labels["colon_left"], 8000, 10000),
    ]
    assert context.reference_axis_names == {cat: "Anatomy"}


def test_the_context_holds_every_reference_axis_but_no_orphan(world):
    procedure_id, axes = world.make_procedure({"Anatomy": ANATOMY, "Quality": ["good", "bad"]})
    acat, alabels = axes["Anatomy"]
    qcat, qlabels = axes["Quality"]
    _, other = world.make_procedure({"Elsewhere": ["q"]})
    _, olabels = other["Elsewhere"]
    video_id = world.make_video(
        procedure_id,
        [
            (acat, alabels["caecum"], 0, 3000),
            (qcat, qlabels["bad"], 1000, 2000),
            (acat, olabels["q"], 3000, 4000),  # orphaned
        ],
    )
    run_id = world.make_run(video_id, make_doc([("Anatomy", ANATOMY, [("caecum", 0.9)] * 3)]))

    context = _load(world, run_id)

    assert sorted(
        (i.category_id, i.label_id, i.start_ms, i.end_ms) for i in context.reference_intervals
    ) == sorted([(acat, alabels["caecum"], 0, 3000), (qcat, qlabels["bad"], 1000, 2000)])
    assert context.reference_axis_names == {acat: "Anatomy", qcat: "Quality"}
    assert [(i.start_ms, i.end_ms) for i in context.axes[0].intervals] == [(0, 3000)]


def test_the_context_counts_malformed_frames_and_keeps_unmatched_axes(world):
    procedure_id, axes = world.make_procedure({"Anatomy": ANATOMY})
    cat, labels = axes["Anatomy"]
    video_id = world.make_video(procedure_id, [(cat, labels["caecum"], 0, 3000)])
    doc = make_doc([
        ("Anatomy", ANATOMY, [("caecum", 0.9)] * 3),
        ("Other", ["x", "y"], [("x", 0.9)] * 3),
    ])
    doc["frames"]["1"]["axes"][0]["class_id"] = 99
    run_id = world.make_run(video_id, doc)

    context = _load(world, run_id)

    anatomy, other = context.axes
    assert anatomy.invalid == 1 and anatomy.frame_indices == [0, 2]
    assert other.reference_axis is None and other.intervals == []
    assert other.frame_indices == [0, 1, 2]


def test_the_context_of_an_unknown_run_is_refused(world):
    with pytest.raises(reference_service.RunNotFound):
        _load(world, 999_999_999)


def test_the_context_of_a_detection_run_is_refused(world):
    procedure_id, axes = world.make_procedure({"Anatomy": ANATOMY})
    cat, labels = axes["Anatomy"]
    video_id = world.make_video(procedure_id, [(cat, labels["caecum"], 0, 3000)])
    run_id = world.make_run(video_id, {"task_type": "detection", "frames": {}})
    with pytest.raises(reference_service.RunNotEvaluable, match="not a classification run"):
        _load(world, run_id)


def test_the_context_of_a_run_that_has_not_finished_is_refused(world):
    procedure_id, axes = world.make_procedure({"Anatomy": ANATOMY})
    cat, labels = axes["Anatomy"]
    video_id = world.make_video(procedure_id, [(cat, labels["caecum"], 0, 3000)])
    run_id = world.make_run(
        video_id, make_doc([("Anatomy", ANATOMY, PREDICTIONS)]), status=InferenceRunStatus.RUNNING
    )
    with pytest.raises(reference_service.RunNotEvaluable, match="not finished"):
        _load(world, run_id)


def test_the_context_without_a_reference_is_refused(world):
    procedure_id, _ = world.make_procedure({"Anatomy": ANATOMY})
    video_id = world.make_video(procedure_id)
    run_id = world.make_run(video_id, make_doc([("Anatomy", ANATOMY, PREDICTIONS)]))
    with pytest.raises(reference_service.RunNotEvaluable, match="no reference intervals"):
        _load(world, run_id)


def test_the_context_with_missing_predictions_is_refused(world):
    _, run_id, _ = _scenario(world)
    world.docs.clear()
    with pytest.raises(reference_service.RunNotEvaluable, match="no longer stored"):
        _load(world, run_id)
