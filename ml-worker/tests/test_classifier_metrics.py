"""Pure-numpy tests: no DB fixtures on purpose."""

import json

import numpy as np
import pytest

from app.classifier_metrics import (
    class_weights,
    confusion_matrix,
    summarize,
    to_result_confusion,
)


def test_class_weights_inverse_frequency_and_cap():
    # counts [90, 10]: total 100, 2 present -> w = 100 / (2 * count)
    #   w0 = 100/180 = 0.5555..., w1 = 100/20 = 5.0
    w = class_weights([90, 10])
    assert w.dtype == np.float64
    assert w[0] == pytest.approx(100 / 180)
    assert w[1] == pytest.approx(5.0)
    # counts [99, 1]: w1 = 100/2 = 50 -> clipped to cap 10; w0 = 100/198
    w = class_weights([99, 1])
    assert w[0] == pytest.approx(100 / 198)
    assert w[1] == pytest.approx(10.0)
    # custom cap
    assert class_weights([99, 1], cap=3.0)[1] == pytest.approx(3.0)
    # perfectly balanced -> all 1.0
    assert class_weights([5, 5, 5]) == pytest.approx([1.0, 1.0, 1.0])


def test_class_weights_zero_count_is_zero():
    # [50, 0, 50]: total 100, 2 present -> 100/(2*50) = 1.0 for present
    assert class_weights([50, 0, 50]).tolist() == [1.0, 0.0, 1.0]
    assert class_weights([0, 0, 0]).tolist() == [0.0, 0.0, 0.0]


def test_confusion_matrix_rows_true_cols_pred():
    cm = confusion_matrix([0, 0, 1, 2], [0, 1, 1, 0], 3)
    assert cm.tolist() == [[1, 1, 0], [0, 1, 0], [1, 0, 0]]
    with pytest.raises(ValueError):
        confusion_matrix([0, 3], [0, 0], 3)


def test_per_class_precision_recall_hand_computed():
    # cm rows = true, cols = predicted
    cm = np.array([[5, 3, 0], [2, 3, 1], [0, 1, 4]])
    # row sums (support) 8, 6, 5; col sums 7, 7, 5; total 19; trace 12
    # c0: P=5/7 R=5/8  F1=2*5/(2*5+2+3)=10/15=2/3
    # c1: P=3/7 R=3/6  F1=6/(6+4+3)=6/13
    # c2: P=4/5 R=4/5  F1=0.8
    s = summarize(cm, ["a", "b", "c"])
    rows = {r["class"]: r for r in s.per_class}
    assert rows["a"]["precision"] == pytest.approx(5 / 7)
    assert rows["a"]["recall"] == pytest.approx(5 / 8)
    assert rows["a"]["f1"] == pytest.approx(2 / 3)
    assert rows["a"]["support"] == 8
    assert rows["b"]["precision"] == pytest.approx(3 / 7)
    assert rows["b"]["recall"] == pytest.approx(0.5)
    assert rows["b"]["f1"] == pytest.approx(6 / 13)
    assert rows["c"]["f1"] == pytest.approx(0.8)
    assert s.accuracy == pytest.approx(12 / 19)
    assert s.macro_f1 == pytest.approx((2 / 3 + 6 / 13 + 0.8) / 3)
    assert s.balanced_accuracy == pytest.approx((5 / 8 + 0.5 + 0.8) / 3)
    assert s.absent == []
    # JSON-serialisable plain Python types
    json.dumps(s.per_class)


def test_macro_f1_ignores_absent_classes():
    # class "c" has no true samples; cm rows: a=[2,0,0], b=[1,1,0], c=[0,0,0]
    # a: tp2 fp1 fn0 -> F1 = 4/5 = 0.8 ; b: tp1 fp0 fn1 -> F1 = 2/3
    # macro over the 2 present classes = (0.8 + 2/3)/2 = 0.73333...
    cm = np.array([[2, 0, 0], [1, 1, 0], [0, 0, 0]])
    s = summarize(cm, ["a", "b", "c"])
    assert s.absent == ["c"]
    assert s.macro_f1 == pytest.approx((0.8 + 2 / 3) / 2)
    assert s.balanced_accuracy == pytest.approx((1.0 + 0.5) / 2)
    row_c = [r for r in s.per_class if r["class"] == "c"][0]
    assert row_c["support"] == 0 and row_c["recall"] == 0.0


def test_balanced_accuracy_differs_from_accuracy_under_imbalance():
    # 90 of class a, 10 of class b; model predicts "a" for everything.
    # cm = [[90, 0], [10, 0]]; accuracy = 90/100 = 0.9
    # recall a = 1.0, recall b = 0.0 -> balanced accuracy = 0.5
    # a: P=90/100=0.9 R=1 F1=2*0.9/1.9 = 18/19 ; b: F1 = 0 -> macro = 9/19
    s = summarize(np.array([[90, 0], [10, 0]]), ["a", "b"])
    assert s.accuracy == pytest.approx(0.9)
    assert s.balanced_accuracy == pytest.approx(0.5)
    assert s.macro_f1 == pytest.approx(9 / 19)
    rows = {r["class"]: r for r in s.per_class}
    assert rows["b"]["precision"] == 0.0  # never predicted
    assert rows["b"]["f1"] == 0.0


def test_empty_confusion_gives_zeros():
    s = summarize(np.zeros((2, 2), dtype=int), ["a", "b"])
    assert s.accuracy == 0.0
    assert s.balanced_accuracy == 0.0
    assert s.macro_f1 == 0.0
    assert s.absent == ["a", "b"]
    assert all(r["support"] == 0 for r in s.per_class)


def test_confusion_result_has_no_background_label():
    cm = confusion_matrix([0, 1, 1], [0, 1, 0], 2)
    out = to_result_confusion(cm, ["a", "b"])
    assert out == {"labels": ["a", "b"], "matrix": [[1, 0], [1, 1]]}
    assert "background" not in out["labels"]
    assert all(type(v) is int for row in out["matrix"] for v in row)
    json.dumps(out)
