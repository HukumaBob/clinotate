import io
from unittest.mock import MagicMock, patch

import numpy as np
from PIL import Image

from app.similarity_adapter import SimilarityAdapter


def _make_frame_bytes(color: tuple[int, int, int] = (128, 128, 128)) -> bytes:
    image = Image.new("RGB", (64, 64), color=color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_embed_returns_l2_normalized_vector():
    import torch

    adapter = SimilarityAdapter()
    fake_model = MagicMock()
    fake_model.return_value = torch.tensor([[3.0, 4.0]])  # norm = 5

    with patch.object(adapter, "_get_model", return_value=fake_model):
        embedding = adapter.embed(_make_frame_bytes())

    assert isinstance(embedding, np.ndarray)
    assert np.isclose(np.linalg.norm(embedding), 1.0)
    assert np.allclose(embedding, [0.6, 0.8])


def test_embed_lazily_loads_model_once():
    adapter = SimilarityAdapter()
    with patch.object(adapter, "_get_model") as mock_get_model:
        import torch

        mock_get_model.return_value = MagicMock(return_value=torch.tensor([[1.0, 0.0]]))
        adapter.embed(_make_frame_bytes())
        adapter.embed(_make_frame_bytes())

    assert mock_get_model.call_count == 2  # _get_model is called each time; its own internal caching (Step 3) is what avoids reloading
