import numpy as np

from app.union_find import cluster_by_threshold


def test_two_similar_frames_form_one_cluster():
    ids = [10, 20, 30]
    matrix = np.array(
        [
            [1.0, 0.9, 0.1],
            [0.9, 1.0, 0.1],
            [0.1, 0.1, 1.0],
        ]
    )
    clusters = cluster_by_threshold(matrix, ids, threshold=0.85)

    non_trivial = [c for c in sorted(clusters, key=len) if len(c) > 1]
    assert len(non_trivial) == 1
    assert sorted(non_trivial[0]) == [10, 20]


def test_transitive_similarity_merges_into_one_cluster():
    """A~B and B~C above threshold, A~C below threshold directly -- still
    one cluster of all three, since Union-Find merges transitively rather
    than requiring every pair to individually exceed the threshold."""
    ids = [1, 2, 3]
    matrix = np.array(
        [
            [1.0, 0.9, 0.2],
            [0.9, 1.0, 0.9],
            [0.2, 0.9, 1.0],
        ]
    )
    clusters = cluster_by_threshold(matrix, ids, threshold=0.85)

    non_trivial = [c for c in clusters if len(c) > 1]
    assert len(non_trivial) == 1
    assert sorted(non_trivial[0]) == [1, 2, 3]


def test_no_pairs_above_threshold_returns_all_singletons():
    ids = [1, 2, 3]
    matrix = np.eye(3)
    clusters = cluster_by_threshold(matrix, ids, threshold=0.85)

    assert all(len(c) == 1 for c in clusters)
    assert sorted(c[0] for c in clusters) == [1, 2, 3]
