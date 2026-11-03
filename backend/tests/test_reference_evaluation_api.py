import json
import time

import pytest
import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
from fastapi.testclient import TestClient

from app.inference.models import InferenceRun, InferenceRunStatus
from app.main import app
from app.media.models import Video
from app.reference import service as reference_service
from app.reference.models import ReferenceInterval, VideoReference
from app.reference.schemas import ReferenceAxisRead, ReferenceClassRead
from app.storage import get_storage_service
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure

client = TestClient(app)

PREDICTIONS = [
    ("caecum", 0.95), ("caecum", 0.95), ("colon_left", 0.90), ("caecum", 0.60),
    ("colon_left", 0.95), ("colon_left", 0.95), ("rectum", 0.95), ("rectum", 0.95),
    ("colon_left", 0.95), ("rectum", 0.80), ("colon_left", 0.95), ("colon_left", 0.95),
]
ANATOMY = ["caecum", "colon_left", "rectum"]


def _headers(email="ref-eval@example.com"):
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    token = client.post("/auth/login", json={"email": email, "password": "pass1234"}).json()[
        "access_token"
    ]
    return {"Authorization": f"Bearer {token}"}


def make_doc(axes):
    """axes: list of (name, classes, [(class_name, confidence)]) with frames every 1000 ms."""
    n = max(len(a[2]) for a in axes)
    return {
        "task_type": "classification",
        "axes": [{"name": a[0], "classes": a[1]} for a in axes],
        "frames": {
            str(i): {
                "timestamp_ms": i * 1000,
                "axes": [
                    {
                        "class_id": a[1].index(a[2][i][0]),
                        "confidence": a[2][i][1],
                        "probs": [],
                    }
                    for a in axes
                ],
            }
            for i in range(n)
        },
    }


class _Storage:
    def __init__(self, docs):
        self.docs = docs

    def download(self, key):
        return json.dumps(self.docs[key]).encode()


@pytest.fixture
def world(committed_inference_rows):
    session = db_module.SessionLocal()
    rows = committed_inference_rows
    docs: dict = {}
    app.dependency_overrides[get_storage_service] = lambda: _Storage(docs)
    ids = {"proc": [], "video": [], "run": [], "eval": None}
    et = session.query(EvaluationType).filter(EvaluationType.name == "frame_classification").first()
    if et is None:
        et = EvaluationType(name="frame_classification", annotation_scope=AnnotationScope.FRAME)
        session.add(et)
        session.flush()
        ids["eval"] = et.id
    session.commit()

    class W:
        pass

    w = W()
    w.docs = docs

    def make_procedure(axes: dict[str, list[str]]):
        procedure = Procedure(name=f"refeval-{len(ids['proc'])}-{time.time_ns()}")
        session.add(procedure)
        session.flush()
        ids["proc"].append(procedure.id)
        out = {}
        for axis, names in axes.items():
            category = Category(name=axis, procedure_id=procedure.id)
            session.add(category)
            session.flush()
            labels = {}
            for name in names:
                label = Label(name=name, category_id=category.id, evaluation_type_id=et.id)
                session.add(label)
                session.flush()
                labels[name] = label.id
            out[axis] = (category.id, labels)
        session.commit()
        return procedure.id, out

    def make_video(procedure_id, intervals=(), compromised=False):
        """intervals: (category_id, label_id, start, end)."""
        video = Video(
            storage_key="ref/e.mp4", title="refeval", procedure_id=procedure_id,
            duration_seconds=100.0, checksum="0" * 64,
        )
        session.add(video)
        session.commit()
        ids["video"].append(video.id)
        if intervals or compromised:
            from datetime import datetime, timezone

            session.add(
                VideoReference(
                    video_id=video.id,
                    compromised_at=datetime.now(timezone.utc) if compromised else None,
                )
            )
            for category_id, label_id, start, end in intervals:
                session.add(
                    ReferenceInterval(
                        video_id=video.id, category_id=category_id, label_id=label_id,
                        taxonomy_version=1, start_ms=start, end_ms=end,
                        created_by_id=rows.user_id,
                    )
                )
            session.commit()
        return video.id

    def make_run(video_id, doc, key=None, status=InferenceRunStatus.SUCCEEDED, axes="auto"):
        key = key or f"refeval/{len(ids['run'])}-{time.time_ns()}.json"
        if doc is not None:
            docs[key] = doc
        if axes == "auto":
            axes = (
                [
                    {"model_version_id": None, "model_name": "m", "name": a["name"],
                     "category_id": None, "classes": a["classes"]}
                    for a in doc["axes"]
                ]
                if doc is not None and doc.get("task_type") == "classification"
                else None
            )
        run = InferenceRun(
            video_id=video_id, model_version_id=None, model_name="m", frame_stride=1,
            axes=axes, status=status, predictions_key=key if doc is not None else None,
            created_by_id=rows.user_id,
        )
        session.add(run)
        session.commit()
        ids["run"].append(run.id)
        return run.id

    w.make_procedure = make_procedure
    w.make_video = make_video
    w.make_run = make_run
    yield w

    app.dependency_overrides.pop(get_storage_service, None)
    session.rollback()
    session.query(InferenceRun).filter(InferenceRun.id.in_(ids["run"])).delete(
        synchronize_session=False
    )
    session.query(ReferenceInterval).filter(ReferenceInterval.video_id.in_(ids["video"])).delete(
        synchronize_session=False
    )
    session.query(VideoReference).filter(VideoReference.video_id.in_(ids["video"])).delete(
        synchronize_session=False
    )
    session.query(Video).filter(Video.id.in_(ids["video"])).delete(synchronize_session=False)
    cats = [c.id for c in session.query(Category).filter(Category.procedure_id.in_(ids["proc"]))]
    session.query(Label).filter(Label.category_id.in_(cats)).delete(synchronize_session=False)
    session.query(Category).filter(Category.id.in_(cats)).delete(synchronize_session=False)
    session.query(Procedure).filter(Procedure.id.in_(ids["proc"])).delete(synchronize_session=False)
    if ids["eval"] is not None:
        session.query(EvaluationType).filter(EvaluationType.id == ids["eval"]).delete(
            synchronize_session=False
        )
    session.commit()
    session.close()


def _scenario(world, compromised=False):
    procedure_id, axes = world.make_procedure({"Anatomy": ANATOMY})
    cat, labels = axes["Anatomy"]
    video_id = world.make_video(
        procedure_id,
        [
            (cat, labels["caecum"], 0, 3000),
            (cat, labels["colon_left"], 3000, 6000),
            (cat, labels["colon_left"], 8000, 10000),
        ],
        compromised=compromised,
    )
    run_id = world.make_run(video_id, make_doc([("Anatomy", ANATOMY, PREDICTIONS)]))
    return video_id, run_id, cat


def _evaluate(run_id, **params):
    return client.get(f"/reference/runs/{run_id}/evaluation", params=params, headers=_headers())


def test_worked_scenario_end_to_end(world):
    video_id, run_id, cat = _scenario(world)
    response = _evaluate(run_id)
    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == run_id and body["video_id"] == video_id
    assert body["reference_status"] == "clean" and body["boundary_ms"] == 2000
    (axis,) = body["axes"]
    assert axis["name"] == "Anatomy" and axis["matched"] is True
    assert axis["reference_category_id"] == cat and axis["reference_axis_name"] == "Anatomy"
    assert (axis["frames_total"], axis["frames_evaluated"], axis["frames_excluded"]) == (12, 8, 4)
    assert axis["accuracy"] == 0.625
    assert axis["confusion"] == {
        "labels": ANATOMY, "matrix": [[2, 1, 0], [1, 3, 1], [0, 0, 0]],
    }
    by_name = {c["name"]: c for c in axis["classes"]}
    c = by_name["caecum"]
    assert (c["tp"], c["fp"], c["fn"], c["support"]) == (2, 1, 1, 3)
    assert c["precision"] == pytest.approx(2 / 3) and c["recall"] == pytest.approx(2 / 3)
    assert c["f1"] == pytest.approx(2 / 3)
    c = by_name["colon_left"]
    assert (c["tp"], c["fp"], c["fn"], c["support"]) == (3, 1, 2, 5)
    assert (c["precision"], c["recall"]) == (0.75, 0.6)
    assert c["f1"] == pytest.approx(2 / 3)
    c = by_name["rectum"]
    assert (c["tp"], c["fp"], c["fn"], c["support"]) == (0, 1, 0, 0)
    assert c["precision"] == 0.0 and c["recall"] is None and c["f1"] == 0.0
    assert axis["macro_f1"] == pytest.approx(2 / 3)
    assert axis["errors"] == {"boundary_frames": 3, "interior_frames": 0}
    assert [
        (e["start_ms"], e["end_ms"], e["frames"], e["truth"], e["predicted"], e["kind"],
         e["mean_confidence"], e["max_confidence"])
        for e in axis["episodes"]
    ] == [
        (2000, 2000, 1, "caecum", "colon_left", "boundary", 0.90, 0.90),
        (3000, 3000, 1, "colon_left", "caecum", "boundary", 0.60, 0.60),
        (9000, 9000, 1, "colon_left", "rectum", "boundary", 0.80, 0.80),
    ]
    t = axis["transitions"]
    assert (t["reference"], t["model_switches"], t["excess_switches"]) == (1, 4, 3)
    assert (t["median_lag_ms"], t["never_switched"]) == (1000, 0)
    assert t["lags"] == [{"at_ms": 3000, "from": "caecum", "to": "colon_left", "lag_ms": 1000}]


def test_small_boundary_makes_interior_episodes(world):
    _, run_id, _ = _scenario(world)
    axis = _evaluate(run_id, boundary_ms=500).json()["axes"][0]
    assert [e["kind"] for e in axis["episodes"]] == ["interior", "boundary", "interior"]
    assert axis["errors"] == {"boundary_frames": 1, "interior_frames": 2}


def test_reference_status_is_passed_through(world):
    _, run_id, _ = _scenario(world, compromised=True)
    assert _evaluate(run_id).json()["reference_status"] == "compromised"


def test_unmatched_axis(world):
    procedure_id, axes = world.make_procedure({"Anatomy": ANATOMY})
    cat, labels = axes["Anatomy"]
    video_id = world.make_video(procedure_id, [(cat, labels["caecum"], 0, 3000)])
    doc = make_doc([("Other", ["x", "y"], [("x", 0.9)] * 5)])
    axis = _evaluate(world.make_run(video_id, doc)).json()["axes"][0]
    assert axis["matched"] is False
    assert axis["reference_category_id"] is None and axis["reference_axis_name"] is None
    assert (axis["frames_total"], axis["frames_evaluated"], axis["frames_excluded"]) == (5, 0, 5)
    assert axis["accuracy"] is None and axis["macro_f1"] is None
    assert axis["classes"] == [] and axis["episodes"] == []
    assert axis["confusion"] == {"labels": [], "matrix": []}
    assert axis["errors"] == {"boundary_frames": 0, "interior_frames": 0}
    assert axis["transitions"]["lags"] == [] and axis["transitions"]["median_lag_ms"] is None


def test_best_overlap_axis_is_picked_among_two(world):
    procedure_id, axes = world.make_procedure(
        {"Quality": ["good", "bad"], "Anatomy": ANATOMY}
    )
    qcat, qlabels = axes["Quality"]
    acat, alabels = axes["Anatomy"]
    video_id = world.make_video(
        procedure_id,
        [(qcat, qlabels["good"], 0, 5000), (acat, alabels["caecum"], 0, 5000)],
    )
    doc = make_doc([("Whatever", ANATOMY, [("caecum", 0.9)] * 3)])
    axis = _evaluate(world.make_run(video_id, doc)).json()["axes"][0]
    assert axis["matched"] is True and axis["reference_category_id"] == acat
    assert axis["reference_axis_name"] == "Anatomy" and axis["frames_evaluated"] == 3


def test_tie_goes_to_the_lower_category_id(world):
    procedure_id, axes = world.make_procedure({"First": ["a", "b"], "Second": ["a", "c"]})
    fcat, flabels = axes["First"]
    scat, slabels = axes["Second"]
    video_id = world.make_video(
        procedure_id, [(fcat, flabels["a"], 0, 5000), (scat, slabels["a"], 0, 5000)]
    )
    doc = make_doc([("M", ["a", "z"], [("a", 0.9)] * 2)])
    axis = _evaluate(world.make_run(video_id, doc)).json()["axes"][0]
    assert axis["reference_category_id"] == min(fcat, scat)


def test_orphaned_intervals_are_ignored(world):
    procedure_id, axes = world.make_procedure({"Anatomy": ANATOMY})
    cat, labels = axes["Anatomy"]
    other_proc, other = world.make_procedure({"Elsewhere": ["q"]})
    ocat, olabels = other["Elsewhere"]
    video_id = world.make_video(
        procedure_id,
        [
            (cat, labels["caecum"], 0, 2000),
            (cat, olabels["q"], 2000, 4000),  # label not on the axis: orphaned
        ],
    )
    doc = make_doc([("Anatomy", ANATOMY, [("caecum", 0.9)] * 5)])
    axis = _evaluate(world.make_run(video_id, doc)).json()["axes"][0]
    assert axis["frames_evaluated"] == 2 and axis["frames_excluded"] == 3


def test_unknown_run_is_404(world):
    assert _evaluate(999999999).status_code == 404


def test_not_evaluable_runs_are_409(world):
    procedure_id, axes = world.make_procedure({"Anatomy": ANATOMY})
    cat, labels = axes["Anatomy"]
    video_id = world.make_video(procedure_id, [(cat, labels["caecum"], 0, 3000)])
    doc = make_doc([("Anatomy", ANATOMY, [("caecum", 0.9)])])
    pending = world.make_run(video_id, doc, status=InferenceRunStatus.PENDING)
    no_key = world.make_run(video_id, None)
    detection = world.make_run(video_id, {"classes": ["polyp"], "frames": {}}, axes=None)
    empty_video = world.make_video(procedure_id)
    no_intervals = world.make_run(empty_video, doc)
    for run_id in (pending, no_key, detection, no_intervals):
        response = _evaluate(run_id)
        assert response.status_code == 409, run_id
        assert isinstance(response.json()["detail"], str)


def test_boundary_ms_is_validated(world):
    _, run_id, _ = _scenario(world)
    assert _evaluate(run_id, boundary_ms=-1).status_code == 422
    assert _evaluate(run_id, boundary_ms=60001).status_code == 422
    assert _evaluate(run_id, boundary_ms=0).status_code == 200
    assert _evaluate(run_id, boundary_ms=60000).status_code == 200


def test_json_has_no_nan_or_infinity(world):
    _, run_id, _ = _scenario(world)
    text = _evaluate(run_id).text
    assert "NaN" not in text and "Infinity" not in text
    json.loads(text, parse_constant=lambda c: pytest.fail(f"non-finite {c}"))


def test_performance_50k_frames_300_intervals(world):
    classes = ["a", "b", "c"]
    procedure_id, axes = world.make_procedure({"Anatomy": classes})
    cat, labels = axes["Anatomy"]
    intervals = [(cat, labels[classes[i % 3]], i * 1000, i * 1000 + 1000) for i in range(300)]
    video_id = world.make_video(procedure_id, intervals)
    n = 50_000
    doc = {
        "task_type": "classification",
        "axes": [{"name": "Anatomy", "classes": classes}],
        "frames": {
            str(i): {
                "timestamp_ms": i * 6,
                "axes": [{"class_id": i % 3, "confidence": 0.8, "probs": []}],
            }
            for i in range(n)
        },
    }
    run_id = world.make_run(video_id, doc)
    session = db_module.SessionLocal()
    try:
        reference = reference_service.get_reference(session, video_id)
        run = session.get(InferenceRun, run_id)
        start = time.perf_counter()
        result = reference_service.evaluate_document(run, doc, reference, 2000)
        elapsed = time.perf_counter() - start
    finally:
        session.close()
    assert result.axes[0].frames_total == n
    assert elapsed < 1.0, f"evaluation took {elapsed:.2f}s"


def test_match_axes_unit():
    def ref(cid, names):
        return ReferenceAxisRead(
            category_id=cid, name=str(cid),
            classes=[ReferenceClassRead(label_id=i, name=n, key=None) for i, n in enumerate(names)],
        )

    refs = [ref(1, ["a", "b"]), ref(2, ["a", "b", "c"]), ref(3, ["a", "b", "c"])]
    got = reference_service.match_axes(
        [{"classes": ["a", "b", "c"]}, {"classes": ["zzz"]}, {"classes": ["a"]}], refs
    )
    assert got == [1, None, 0]
