import pytest
from pydantic import ValidationError

import app.main  # noqa: F401
from app.inference.schemas import PerturbationSpec


@pytest.mark.parametrize(
    "kind,strength",
    [("gaussian_noise", 10), ("blur", 2.5), ("brightness", -40), ("jpeg", 30)],
)
def test_valid_specs_are_accepted(kind, strength):
    assert PerturbationSpec(kind=kind, strength=strength).strength == strength


@pytest.mark.parametrize(
    "kind,strength",
    [
        ("gaussian_noise", 0), ("gaussian_noise", 101), ("blur", 0.1), ("blur", 21),
        ("brightness", 0), ("brightness", 101), ("jpeg", 4), ("jpeg", 96),
        ("jpeg", float("nan")), ("blur", float("inf")),
    ],
)
def test_out_of_range_strength_is_rejected(kind, strength):
    with pytest.raises(ValidationError):
        PerturbationSpec(kind=kind, strength=strength)


def test_unknown_kind_is_rejected():
    with pytest.raises(ValidationError):
        PerturbationSpec(kind="rotate", strength=5)
