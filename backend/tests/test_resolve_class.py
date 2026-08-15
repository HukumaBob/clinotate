import app.main  # noqa: F401 -- registers every model on Base.metadata for test_engine's create_all/drop_all
from app.taxonomy.hierarchy import GroupingRules, LabelNode, LabelTree, resolve_class


def _tree(*nodes: LabelNode) -> LabelTree:
    return LabelTree(nodes={node.id: node for node in nodes})


# Shape used by most tests:
#   1 polyp (abstract)
#     +-- 2 sessile
#     +-- 3 pedunculated
#   4 standalone (no parent, no children)
POLYP_TREE = _tree(
    LabelNode(id=1, parent_label_id=None, is_abstract=True),
    LabelNode(id=2, parent_label_id=1, is_abstract=False),
    LabelNode(id=3, parent_label_id=1, is_abstract=False),
    LabelNode(id=4, parent_label_id=None, is_abstract=False),
)


def test_root_leaf_resolves_to_itself():
    assert resolve_class(4, POLYP_TREE, GroupingRules()) == 4


def test_child_resolves_to_parent_by_default():
    # A node with children defaults to collapsed -- that is the taxonomy's memory.
    assert resolve_class(2, POLYP_TREE, GroupingRules()) == 1
    assert resolve_class(3, POLYP_TREE, GroupingRules()) == 1


def test_expanding_a_parent_keeps_children_separate():
    rules = GroupingRules(expand=frozenset({1}))
    assert resolve_class(2, POLYP_TREE, rules) == 2
    assert resolve_class(3, POLYP_TREE, rules) == 3


def test_a_collapsed_parent_resolves_to_itself():
    assert resolve_class(1, POLYP_TREE, GroupingRules()) == 1


def test_direct_annotations_on_a_concrete_parent_join_its_children():
    # low_quality (10) is concrete and carries its own annotations.
    tree = _tree(
        LabelNode(id=10, parent_label_id=None, is_abstract=False),
        LabelNode(id=11, parent_label_id=10, is_abstract=False),
        LabelNode(id=12, parent_label_id=10, is_abstract=False),
    )
    rules = GroupingRules()
    assert resolve_class(10, tree, rules) == 10
    assert resolve_class(11, tree, rules) == 10
    assert resolve_class(12, tree, rules) == 10


def test_expanded_concrete_parent_forms_its_own_class():
    tree = _tree(
        LabelNode(id=10, parent_label_id=None, is_abstract=False),
        LabelNode(id=11, parent_label_id=10, is_abstract=False),
    )
    rules = GroupingRules(expand=frozenset({10}))
    assert resolve_class(10, tree, rules) == 10
    assert resolve_class(11, tree, rules) == 11


def test_highest_collapsed_ancestor_wins_in_a_multi_level_tree():
    # 100 polyp -> 200 LST -> 300 lst_g_homogeneous
    # The schema permits depth even though the first UI renders one level,
    # so the behaviour is pinned here.
    tree = _tree(
        LabelNode(id=100, parent_label_id=None, is_abstract=True),
        LabelNode(id=200, parent_label_id=100, is_abstract=True),
        LabelNode(id=300, parent_label_id=200, is_abstract=False),
    )
    assert resolve_class(300, tree, GroupingRules()) == 100


def test_expanding_the_top_falls_back_to_the_next_collapsed_ancestor():
    tree = _tree(
        LabelNode(id=100, parent_label_id=None, is_abstract=True),
        LabelNode(id=200, parent_label_id=100, is_abstract=True),
        LabelNode(id=300, parent_label_id=200, is_abstract=False),
    )
    rules = GroupingRules(expand=frozenset({100}))
    assert resolve_class(300, tree, rules) == 200


def test_abstractness_does_not_affect_resolution():
    # Expanding an abstract parent is legitimate: it yields the subtypes as
    # classes with no parent class at all. is_abstract governs who may
    # annotate a label, never how it resolves.
    rules = GroupingRules(expand=frozenset({1}))
    assert resolve_class(2, POLYP_TREE, rules) == 2
    assert resolve_class(1, POLYP_TREE, rules) == 1


def test_unknown_label_resolves_to_itself():
    assert resolve_class(9999, POLYP_TREE, GroupingRules()) == 9999
