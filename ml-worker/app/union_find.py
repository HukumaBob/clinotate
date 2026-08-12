import numpy as np


def cluster_by_threshold(
    similarity_matrix: np.ndarray, ids: list[int], threshold: float
) -> list[list[int]]:
    """Groups `ids` into clusters using Union-Find: any pair (i, j) with
    similarity_matrix[i][j] >= threshold is merged into the same cluster,
    transitively (A~B and B~C merges A, B, C into one cluster even if A~C
    is below threshold directly). Returns every id, including singletons
    (frames with no near-duplicate) as their own one-element cluster."""
    n = len(ids)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        root_a, root_b = find(a), find(b)
        if root_a != root_b:
            parent[root_b] = root_a

    for i in range(n):
        for j in range(i + 1, n):
            if similarity_matrix[i][j] >= threshold:
                union(i, j)

    groups: dict[int, list[int]] = {}
    for index in range(n):
        root = find(index)
        groups.setdefault(root, []).append(ids[index])

    return list(groups.values())
