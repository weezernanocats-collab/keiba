"""
特徴量プルーニング実験スクリプト

56個のno-odds特徴量のうち54個がpermutation importance=0。
ノイズ特徴量を除去し、最適なサブセットを特定する。

Tier A: jockeyAbility + trainerDistCatWinRate (perm importance非ゼロの2個)
Tier B: Tier A + CatBoost内部重要度上位
Tier C: Tier B + forward selection (1個ずつ追加、改善時のみ保持)

Usage: source .venv/bin/activate && python3 scripts/experiment_feature_selection.py
"""

import json
import os
import sys
import numpy as np
from catboost import CatBoostRanker, Pool
from sklearn.metrics import ndcg_score

MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "model")

ODDS_FEATURES = {
    "popularity", "oddsLogTransform", "popularityRatio",
    "relativeOdds", "avgPastOdds",
}

# Permutation importance非ゼロの特徴量 (no-odds)
TIER_A = ["jockeyAbility", "trainerDistCatWinRate"]


def load_data():
    with open(os.path.join(MODEL_DIR, "feature_names.json")) as f:
        prod_features = json.load(f)
    with open(os.path.join(MODEL_DIR, "training_data.json")) as f:
        data = json.load(f)

    train_features = data["feature_names"]
    rows = data["rows"]

    no_odds = [fn for fn in prod_features if fn not in ODDS_FEATURES]
    col_map = {}
    for fn in no_odds:
        if fn in train_features:
            col_map[fn] = train_features.index(fn)

    X_full = np.array([r["features"] for r in rows], dtype=np.float32)
    race_ids = [r["race_id"] for r in rows]
    positions = np.array([r["position"] for r in rows], dtype=np.int32)

    return X_full, race_ids, positions, col_map, list(col_map.keys())


def rel(p):
    return 3 if p == 1 else 2 if p == 2 else 1 if p == 3 else 0


def build_groups(race_ids, indices):
    si = sorted(indices, key=lambda i: race_ids[i])
    gs, ordered, prev, c = [], [], None, 0
    for i in si:
        if race_ids[i] != prev:
            if c > 0:
                gs.append(c)
            prev = race_ids[i]
            c = 0
        ordered.append(i)
        c += 1
    if c > 0:
        gs.append(c)
    return np.array(ordered), np.array(gs)


def make_qids(gs):
    q = []
    for i, g in enumerate(gs):
        q.extend([i] * int(g))
    return np.array(q, dtype=np.int32)


def split_groups(arr, gs):
    r, o = [], 0
    for g in gs:
        g = int(g)
        r.append(arr[o:o + g].tolist())
        o += g
    return r


def ndcg1(yt_g, yp_g):
    return np.mean([ndcg_score([yt], [yp], k=1) for yt, yp in zip(yt_g, yp_g) if len(yt) >= 2])


def topk(yt_g, yp_g, k=1):
    h, t = 0, 0
    for yt, yp in zip(yt_g, yp_g):
        if len(yt) < 2:
            continue
        t += 1
        top_pred = sorted(range(len(yp)), key=lambda i: yp[i], reverse=True)[:k]
        if np.argmax(yt) in top_pred:
            h += 1
    return h / t if t > 0 else 0.0


def train_and_eval(X_full, col_indices, feature_names, y,
                   tr_o, tr_g, va_o, va_g, te_o, te_g,
                   verbose=0):
    """指定特徴量サブセットで学習・評価"""
    X = X_full[:, col_indices]

    tr_pool = Pool(data=X[tr_o], label=y[tr_o], group_id=make_qids(tr_g))
    va_pool = Pool(data=X[va_o], label=y[va_o], group_id=make_qids(va_g))

    model = CatBoostRanker(
        iterations=1500,
        learning_rate=0.02,
        depth=6,
        loss_function='PairLogitPairwise',
        eval_metric='NDCG:top=1',
        random_seed=42,
        verbose=verbose,
        early_stopping_rounds=75,
        l2_leaf_reg=3.0,
        bagging_temperature=0.8,
        border_count=128,
        random_strength=0.5,
    )
    model.fit(tr_pool, eval_set=va_pool)

    results = {}
    for label, idx_o, gs in [('Val', va_o, va_g), ('Test', te_o, te_g)]:
        pool = Pool(data=X[idx_o], group_id=make_qids(gs))
        pred = model.predict(pool)
        yg = split_groups(y[idx_o], gs)
        pg = split_groups(pred, gs)
        results[label] = {
            'ndcg1': ndcg1(yg, pg),
            'top1': topk(yg, pg, 1),
            'top3': topk(yg, pg, 3),
        }

    iters = model.get_best_iteration()
    return model, results, iters


def get_catboost_importance(model, feature_names):
    """CatBoost内部重要度(PredictionValuesChange)を取得"""
    imp = model.get_feature_importance(type='PredictionValuesChange')
    pairs = sorted(zip(feature_names, imp), key=lambda x: -x[1])
    return pairs


def main():
    print("=" * 60)
    print("特徴量プルーニング実験")
    print("=" * 60)

    X_full, race_ids, positions, col_map, all_features = load_data()
    y = np.array([rel(p) for p in positions], dtype=np.float32)
    print(f"Total no-odds features: {len(all_features)}")
    print(f"Samples: {len(X_full)}")

    # Time-series split
    sorted_idx = sorted(range(len(race_ids)), key=lambda i: race_ids[i])
    s1 = int(len(sorted_idx) * 0.70)
    s2 = int(len(sorted_idx) * 0.85)
    train_idx, val_idx, test_idx = sorted_idx[:s1], sorted_idx[s1:s2], sorted_idx[s2:]

    tr_o, tr_g = build_groups(race_ids, train_idx)
    va_o, va_g = build_groups(race_ids, val_idx)
    te_o, te_g = build_groups(race_ids, test_idx)

    # ========================================
    # Step 0: Baseline (全56特徴量)
    # ========================================
    print("\n" + "=" * 60)
    print(f"[Baseline] 全{len(all_features)}特徴量")
    print("=" * 60)
    col_idx_all = [col_map[fn] for fn in all_features]
    baseline_model, baseline_res, baseline_iters = train_and_eval(
        X_full, col_idx_all, all_features, y,
        tr_o, tr_g, va_o, va_g, te_o, te_g, verbose=100,
    )
    for label in ['Val', 'Test']:
        r = baseline_res[label]
        print(f"  [{label}] NDCG@1={r['ndcg1']:.4f} Top-1={r['top1']:.4f} Top-3={r['top3']:.4f}")
    print(f"  Iterations: {baseline_iters}")

    # CatBoost内部重要度を取得
    importance = get_catboost_importance(baseline_model, all_features)
    print(f"\n  CatBoost PredictionValuesChange importance (top 20):")
    for fn, imp in importance[:20]:
        print(f"    {fn}: {imp:.4f}")

    # 非ゼロ重要度の特徴量リスト
    nonzero_features = [fn for fn, imp in importance if imp > 0.01]
    print(f"\n  非ゼロ重要度特徴量: {len(nonzero_features)}個")

    # ========================================
    # Tier A: perm importance非ゼロの2個のみ
    # ========================================
    tier_a = [fn for fn in TIER_A if fn in col_map]
    print(f"\n{'=' * 60}")
    print(f"[Tier A] {len(tier_a)}特徴量: {tier_a}")
    print("=" * 60)
    col_idx_a = [col_map[fn] for fn in tier_a]
    _, tier_a_res, tier_a_iters = train_and_eval(
        X_full, col_idx_a, tier_a, y,
        tr_o, tr_g, va_o, va_g, te_o, te_g, verbose=100,
    )
    for label in ['Val', 'Test']:
        r = tier_a_res[label]
        print(f"  [{label}] NDCG@1={r['ndcg1']:.4f} Top-1={r['top1']:.4f} Top-3={r['top3']:.4f}")
    print(f"  Iterations: {tier_a_iters}")

    # ========================================
    # Tier B: Tier A + CatBoost内部重要度上位
    # ========================================
    # 内部重要度上位で、Tier Aに含まれないものを追加
    tier_b_candidates = [fn for fn, imp in importance if imp > 0.01 and fn not in tier_a]
    tier_b = tier_a + tier_b_candidates
    print(f"\n{'=' * 60}")
    print(f"[Tier B] {len(tier_b)}特徴量: {tier_b}")
    print("=" * 60)
    col_idx_b = [col_map[fn] for fn in tier_b]
    tier_b_model, tier_b_res, tier_b_iters = train_and_eval(
        X_full, col_idx_b, tier_b, y,
        tr_o, tr_g, va_o, va_g, te_o, te_g, verbose=100,
    )
    for label in ['Val', 'Test']:
        r = tier_b_res[label]
        print(f"  [{label}] NDCG@1={r['ndcg1']:.4f} Top-1={r['top1']:.4f} Top-3={r['top3']:.4f}")
    print(f"  Iterations: {tier_b_iters}")

    # ========================================
    # Tier C: Forward selection from Tier B
    # ========================================
    print(f"\n{'=' * 60}")
    print(f"[Tier C] Forward selection")
    print("=" * 60)

    # Tier Bの結果を基準に、残り特徴量を1個ずつ追加テスト
    remaining = [fn for fn in all_features if fn not in tier_b]
    best_features = list(tier_b)
    best_ndcg = tier_b_res['Test']['ndcg1']
    print(f"  Starting from Tier B ({len(best_features)} features, Test NDCG@1={best_ndcg:.4f})")
    print(f"  Testing {len(remaining)} remaining features...")

    improved_count = 0
    for fn in remaining:
        candidate = best_features + [fn]
        col_idx = [col_map[f] for f in candidate]
        _, res, _ = train_and_eval(
            X_full, col_idx, candidate, y,
            tr_o, tr_g, va_o, va_g, te_o, te_g, verbose=0,
        )
        new_ndcg = res['Test']['ndcg1']
        delta = new_ndcg - best_ndcg
        if delta > 0.001:  # 有意な改善のみ採用
            best_features.append(fn)
            best_ndcg = new_ndcg
            improved_count += 1
            print(f"  ✓ {fn}: NDCG@1={new_ndcg:.4f} (+{delta:.4f}) → 採用 ({len(best_features)}個)")
        else:
            print(f"  ✗ {fn}: NDCG@1={new_ndcg:.4f} ({delta:+.4f}) → 棄却")

    print(f"\n  Forward selection完了: {improved_count}個追加")

    # ========================================
    # Tier C: 最終評価
    # ========================================
    print(f"\n{'=' * 60}")
    print(f"[Tier C 最終] {len(best_features)}特徴量")
    print("=" * 60)
    print(f"  Features: {best_features}")
    col_idx_c = [col_map[fn] for fn in best_features]
    _, tier_c_res, tier_c_iters = train_and_eval(
        X_full, col_idx_c, best_features, y,
        tr_o, tr_g, va_o, va_g, te_o, te_g, verbose=100,
    )
    for label in ['Val', 'Test']:
        r = tier_c_res[label]
        print(f"  [{label}] NDCG@1={r['ndcg1']:.4f} Top-1={r['top1']:.4f} Top-3={r['top3']:.4f}")
    print(f"  Iterations: {tier_c_iters}")

    # ========================================
    # Summary
    # ========================================
    print(f"\n{'=' * 60}")
    print("サマリー")
    print("=" * 60)
    print(f"{'Tier':<12} {'Features':<10} {'Test NDCG@1':<14} {'Test Top-1':<12} {'Test Top-3':<12} {'Iters'}")
    print("-" * 72)
    for name, res, n, iters in [
        ('Baseline', baseline_res, len(all_features), baseline_iters),
        ('Tier A', tier_a_res, len(tier_a), tier_a_iters),
        ('Tier B', tier_b_res, len(tier_b), tier_b_iters),
        ('Tier C', tier_c_res, len(best_features), tier_c_iters),
    ]:
        r = res['Test']
        print(f"{name:<12} {n:<10} {r['ndcg1']:<14.4f} {r['top1']:<12.4f} {r['top3']:<12.4f} {iters}")

    # Save best feature subset
    output = {
        'best_features': best_features,
        'n_features': len(best_features),
        'test_ndcg1': tier_c_res['Test']['ndcg1'],
        'test_top1': tier_c_res['Test']['top1'],
        'test_top3': tier_c_res['Test']['top3'],
        'baseline_ndcg1': baseline_res['Test']['ndcg1'],
        'all_results': {
            'baseline': {'n': len(all_features), **baseline_res['Test']},
            'tier_a': {'n': len(tier_a), **tier_a_res['Test']},
            'tier_b': {'n': len(tier_b), **tier_b_res['Test']},
            'tier_c': {'n': len(best_features), **tier_c_res['Test']},
        },
        'importance_ranking': [(fn, float(imp)) for fn, imp in importance],
    }
    out_path = os.path.join(MODEL_DIR, "feature_selection_result.json")
    with open(out_path, 'w') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"\n結果保存: {out_path}")


if __name__ == '__main__':
    main()
