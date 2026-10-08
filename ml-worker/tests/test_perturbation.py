import numpy as np
import pytest

from app.perturbation import apply_perturbation


def _image():
    rng = np.random.default_rng(0)
    return rng.integers(0, 256, (48, 64, 3), dtype=np.uint8)


def test_none_returns_the_same_image():
    image = _image()
    assert apply_perturbation(image, None) is image


@pytest.mark.parametrize(
    "spec",
    [
        {"kind": "gaussian_noise", "strength": 20},
        {"kind": "blur", "strength": 3},
        {"kind": "brightness", "strength": 40},
        {"kind": "jpeg", "strength": 10},
    ],
)
def test_every_kind_keeps_shape_and_dtype_and_changes_pixels(spec):
    image = _image()
    out = apply_perturbation(image, spec, seed=1)
    assert out.shape == image.shape and out.dtype == np.uint8
    assert not np.array_equal(out, image)


def test_input_is_not_modified():
    image = _image()
    before = image.copy()
    apply_perturbation(image, {"kind": "gaussian_noise", "strength": 30}, seed=2)
    assert np.array_equal(image, before)


def test_noise_is_reproducible_per_seed_and_differs_between_seeds():
    spec = {"kind": "gaussian_noise", "strength": 25}
    a = apply_perturbation(_image(), spec, seed=5)
    assert np.array_equal(a, apply_perturbation(_image(), spec, seed=5))
    assert not np.array_equal(a, apply_perturbation(_image(), spec, seed=6))


def test_brightness_clips_instead_of_wrapping():
    white = np.full((4, 4, 3), 250, dtype=np.uint8)
    assert apply_perturbation(white, {"kind": "brightness", "strength": 50}).max() == 255
    black = np.full((4, 4, 3), 5, dtype=np.uint8)
    assert apply_perturbation(black, {"kind": "brightness", "strength": -50}).min() == 0


def test_unknown_kind_raises():
    with pytest.raises(ValueError):
        apply_perturbation(_image(), {"kind": "rotate", "strength": 1})
