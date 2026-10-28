"""Pure tests for dinov3_crops: no database, no torch."""

import json
from pathlib import Path

import cv2
import numpy as np

from app.dinov3_crops import Sample, crop_region, load_samples, read_rgb


def _blank(h=200, w=300, colour=(50, 100, 150)):
    img = np.empty((h, w, 3), dtype=np.uint8)
    img[:] = colour
    return img


def test_crop_is_square_and_imgsz():
    img = _blank(200, 300, colour=(0, 0, 0))
    # Wide 100x20 box at (100, 90); a white vertical bar 4 wide x 20 tall inside.
    img[90:110, 148:152] = 255
    out = crop_region(
        img,
        (100, 90, 100, 20),
        [],
        margin=0.0,
        mask_mode="none",
        imgsz=224,
    )
    assert out.shape == (224, 224, 3)
    assert out.dtype == np.uint8
    # Padded square is 100x100 -> scale 2.24: bar should be ~9 wide, ~45 tall.
    white = out.min(axis=2) > 200
    ys, xs = np.where(white)
    bar_w = xs.max() - xs.min() + 1
    bar_h = ys.max() - ys.min() + 1
    assert abs(bar_h - 20 * 2.24) <= 2
    assert abs(bar_w - 4 * 2.24) <= 2
    assert abs(bar_w / bar_h - 4 / 20) < 0.05
    # Centred: box is 100x20 padded to 100x100, so 40 pad rows above and
    # below; bar spans rows 40..60 -> 89.6..134.4 after the 2.24 scale.
    assert abs(ys.min() - 40 * 2.24) <= 2
    assert abs(ys.max() + 1 - 60 * 2.24) <= 2
    assert (out[:80] == out[0, 0]).all() and (out[150:] == out[0, 0]).all()


def test_crop_clamps_at_image_border():
    img = _blank(100, 100)
    out = crop_region(
        img,
        (0, 0, 40, 40),
        [],
        margin=0.5,
        mask_mode="none",
        imgsz=64,
    )
    assert out.shape == (64, 64, 3)
    out = crop_region(
        img,
        (70, 70, 30, 30),
        [(70, 70), (100, 70), (100, 100)],
        margin=0.5,
        mask_mode="blur",
        imgsz=64,
    )
    assert out.shape == (64, 64, 3)


def test_mask_mode_zero_fills_outside_polygon():
    rng = np.random.default_rng(0)
    img = rng.integers(0, 256, size=(100, 100, 3), dtype=np.uint8)
    bbox = (20, 20, 60, 60)
    triangle = [(20, 80), (80, 80), (50, 20)]
    out = crop_region(
        img, bbox, triangle, margin=0.0, mask_mode="zero", imgsz=60
    )
    crop = img[20:80, 20:80]
    mean = np.round(crop.reshape(-1, 3).mean(axis=0)).astype(np.uint8)
    # Top-left corner of the box is outside the triangle.
    assert (out[0, 0] == mean).all()
    assert (out[1, 1] == mean).all()
    # Centre of the lower part is inside and unchanged.
    assert (out[50, 30] == crop[50, 30]).all()
    assert (out[45, 30] == crop[45, 30]).all()


def test_mask_mode_none_ignores_polygon():
    rng = np.random.default_rng(1)
    img = rng.integers(0, 256, size=(100, 100, 3), dtype=np.uint8)
    bbox = (20, 20, 60, 60)
    a = crop_region(img, bbox, [(20, 80), (80, 80), (50, 20)], margin=0.0,
                    mask_mode="none", imgsz=60)
    b = crop_region(img, bbox, [], margin=0.0, mask_mode="none", imgsz=60)
    assert np.array_equal(a, b)
    assert np.array_equal(a, img[20:80, 20:80])


def test_mask_with_degenerate_polygon_falls_back_to_box_crop():
    rng = np.random.default_rng(2)
    img = rng.integers(0, 256, size=(100, 100, 3), dtype=np.uint8)
    bbox = (20, 20, 60, 60)
    plain = crop_region(img, bbox, [], margin=0.0, mask_mode="none", imgsz=60)
    for mode in ("zero", "blur"):
        out = crop_region(img, bbox, [(20, 20), (30, 30)], margin=0.0,
                          mask_mode=mode, imgsz=60)
        assert np.array_equal(out, plain)


def _write_dataset(tmp_path: Path, images, categories, annotations, files=None):
    root = tmp_path / "ds"
    (root / "images" / "train").mkdir(parents=True)
    (root / "images" / "val").mkdir(parents=True)
    (root / "annotations.json").write_text(
        json.dumps(
            {"images": images, "categories": categories, "annotations": annotations}
        )
    )
    for rel in files if files is not None else [
        f"{i['split']}/{i['file_name']}" for i in images
    ]:
        cv2.imwrite(str(root / "images" / rel), np.zeros((20, 20, 3), np.uint8))
    return root


def _ann(i, image_id, cat, bbox=(2, 2, 10, 10), poly=None):
    x, y, w, h = bbox
    poly = poly if poly is not None else [x, y, x + w, y, x + w, y + h]
    return {"id": i, "image_id": image_id, "category_id": cat, "bbox": list(bbox),
            "segmentation": [poly], "area": 1.0, "iscrowd": 0}


def _img(i, split="train", name=None):
    return {"id": i, "file_name": name or f"f{i}.png", "width": 20, "height": 20,
            "split": split}


def test_load_samples_remaps_sparse_category_ids(tmp_path):
    root = _write_dataset(
        tmp_path,
        [_img(1), _img(2)],
        [{"id": 7, "name": "b"}, {"id": 3, "name": "a"}],
        [_ann(1, 1, 7), _ann(2, 2, 3)],
    )
    samples, names = load_samples(root, lambda m: None)
    assert names == ["a", "b"]
    by_image = {s.image_path.name: s.class_id for s in samples}
    assert by_image == {"f1.png": 1, "f2.png": 0}
    assert isinstance(samples[0], Sample)
    assert samples[0].polygon == [(2.0, 2.0), (12.0, 2.0), (12.0, 12.0)]


def test_load_samples_skips_degenerate_and_missing_and_logs_count(tmp_path):
    root = _write_dataset(
        tmp_path,
        [_img(1), _img(2), _img(3)],
        [{"id": 1, "name": "a"}],
        [
            _ann(1, 1, 1),
            _ann(2, 2, 1),  # image 2 file will be missing
            _ann(3, 3, 1, bbox=(2, 2, 0, 5)),  # empty box
            _ann(4, 1, 99),  # unknown category
        ],
        files=["train/f1.png", "train/f3.png"],
    )
    logs: list[str] = []
    samples, names = load_samples(root, logs.append)
    assert len(samples) == 1
    assert names == ["a"]
    skipped = [m for m in logs if "Skipped" in m]
    assert len(skipped) == 1
    assert "Skipped 3 regions" in skipped[0]
    assert "1 missing image file" in skipped[0]
    assert "1 empty box" in skipped[0]
    assert "1 unknown category" in skipped[0]


def test_load_samples_keeps_short_polygon_regions(tmp_path):
    root = _write_dataset(
        tmp_path, [_img(1)], [{"id": 1, "name": "a"}],
        [_ann(1, 1, 1, poly=[])],
    )
    samples, _ = load_samples(root, lambda m: None)
    assert len(samples) == 1
    assert samples[0].polygon == []


def test_load_samples_uses_export_split(tmp_path):
    root = _write_dataset(
        tmp_path,
        [_img(1, "train"), _img(2, "val")],
        [{"id": 1, "name": "a"}],
        [_ann(1, 1, 1), _ann(2, 2, 1)],
    )
    samples, _ = load_samples(root, lambda m: None)
    assert {s.image_path.name: s.split for s in samples} == {
        "f1.png": "train",
        "f2.png": "val",
    }
    assert all(s.image_path.parent.name == s.split for s in samples)


def test_negative_images_yield_no_samples(tmp_path):
    root = _write_dataset(
        tmp_path, [_img(1), _img(2)], [{"id": 1, "name": "a"}], [_ann(1, 1, 1)]
    )
    samples, _ = load_samples(root, lambda m: None)
    assert [s.image_path.name for s in samples] == ["f1.png"]


def test_read_rgb_converts_from_bgr(tmp_path):
    bgr = np.zeros((4, 4, 3), np.uint8)
    bgr[..., 2] = 255  # red in BGR
    p = tmp_path / "x.png"
    cv2.imwrite(str(p), bgr)
    rgb = read_rgb(p)
    assert (rgb[0, 0] == (255, 0, 0)).all()


def test_mask_zero_wide_box_with_margin_keeps_offsets():
    rng = np.random.default_rng(3)
    img = rng.integers(0, 256, size=(120, 200, 3), dtype=np.uint8)
    # bbox (50,40,80,20), margin 0.2 -> mx=16, my=4 -> crop x 34..146,
    # y 36..64 (112x28). side=112, off_x=0, off_y=(112-28)//2=42.
    # imgsz=112 so no resize. Polygon rectangle x 60..120, y 40..60 maps to
    # square cols 26..86, rows 46..66.
    poly = [(60, 40), (120, 40), (120, 60), (60, 60)]
    out = crop_region(img, (50, 40, 80, 20), poly, margin=0.2,
                      mask_mode="zero", imgsz=112)
    mean = np.round(img[36:64, 34:146].reshape(-1, 3).mean(axis=0)).astype(np.uint8)
    # Inside: square (row 56, col 50) = image (y=56-42+36=50, x=50+34=84).
    # Dropping off_y would put the polygon at rows 4..24; dropping the crop
    # origin would put it at cols 60..120 -> both would make this mean.
    assert (out[56, 50] == img[50, 84]).all()
    # Outside, square (56, 90) = image x=124 > 120. Only true if the crop
    # origin is applied (without it the polygon would cover col 90).
    assert (out[56, 90] == mean).all()
    # Outside, square (56, 10) = image x=44 < 60.
    assert (out[56, 10] == mean).all()


def test_mask_zero_box_clamped_at_corner():
    rng = np.random.default_rng(4)
    img = rng.integers(0, 256, size=(100, 100, 3), dtype=np.uint8)
    # bbox (0,0,40,40), margin 0.3 -> mx=my=12; unclamped origin -12,
    # clamped crop is x 0..52, y 0..52 (square, origin 0, no pad).
    # Triangle (0,0),(50,0),(0,50). imgsz=52 so no resize.
    tri = [(0, 0), (50, 0), (0, 50)]
    out = crop_region(img, (0, 0, 40, 40), tri, margin=0.3,
                      mask_mode="zero", imgsz=52)
    mean = np.round(img[0:52, 0:52].reshape(-1, 3).mean(axis=0)).astype(np.uint8)
    # (10,10): x+y=20 <= 50 inside. An unclamped origin of -12 would shift
    # the triangle to start at 12, making (10,10) outside.
    assert (out[10, 10] == img[10, 10]).all()
    # (30,30): x+y=60 > 50 outside; with the shifted triangle (x+y <= 74)
    # it would wrongly stay inside.
    assert (out[30, 30] == mean).all()


def _split_dataset(tmp_path, images):
    return _write_dataset(
        tmp_path,
        images,
        [{"id": 1, "name": "a"}],
        [_ann(i["id"], i["id"], 1) for i in images],
        files=[],
    )


def test_load_samples_skips_unknown_or_missing_split(tmp_path):
    good = _img(1, "test")
    no_split = _img(2)
    del no_split["split"]
    holdout = _img(3, "holdout")
    root = _split_dataset(tmp_path, [good, no_split, holdout])
    (root / "images" / "test").mkdir()
    cv2.imwrite(str(root / "images" / "test" / "f1.png"), np.zeros((20, 20, 3), np.uint8))
    logs: list[str] = []
    samples, _ = load_samples(root, logs.append)
    assert [(s.image_path.name, s.split) for s in samples] == [("f1.png", "test")]
    line = [m for m in logs if "Skipped" in m]
    assert len(line) == 1
    assert "Skipped 2 regions" in line[0]
    assert "2 unknown or missing split" in line[0]
