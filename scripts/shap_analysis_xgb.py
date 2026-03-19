"""
XGBoost Feature Importance Analysis (gain/weight/cover + permutation)
Turso reads: ZERO (local training_data.json + model files only)

Uses XGBoost native importance (no SHAP dependency - avoids Python 3.14 crash)
Plus permutation importance for validation.
"""

import json
import os
import sys

import numpy as np
import xgboost as xgb

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "model")
LOCAL_DATA_FILE = os.path.join(MODEL_DIR, "training_data.json")

CATEGORIES = {
    'turf_sprint': (0, 0, 1400),
    'turf_mile': (0, 1401, 1800),
    'turf_long': (0, 1801, 99999),
    'dirt_short': (1, 0, 1600),
    'dirt_long': (1, 1601, 99999),
}


def categorize_race(track_type_encoded, distance):
    for cat, (tt, d_min, d_max) in CATEGORIES.items():
        if int(track_type_encoded) == tt and d_min <= distance <= d_max:
            return cat
    return None


def build_race_groups(race_ids, indices):
    sorted_idx = sorted(indices, key=lambda i: race_ids[i])
    groups, ordered_indices = [], []
    current_race, current_count = None, 0
    for i in sorted_idx:
        rid = race_ids[i]
        if rid != current_race:
            if current_count > 0:
                groups.append(current_count)
            current_race = rid
            current_count = 0
        current_count += 1
        ordered_indices.append(i)
    if current_count > 0:
        groups.append(current_count)
    return np.array(ordered_indices), np.array(groups)


def split_by_groups(y, groups):
    result = []
    offset = 0
    for g in groups:
        result.append(y[offset:offset + int(g)].tolist())
        offset += int(g)
    return result


def softmax_np(scores):
    max_s = np.max(scores)
    exps = np.exp(scores - max_s)
    return exps / np.sum(exps)


def get_native_importance(model, feature_names):
    """XGBoost native feature importance (gain, weight, cover)"""
    results = {}
    for imp_type in ['gain', 'weight', 'cover']:
        scores = model.get_booster().get_score(importance_type=imp_type)
        total = sum(scores.values()) if scores else 1
        feat_scores = {}
        for fname in feature_names:
            # XGBoost uses f0, f1... or feature names
            val = scores.get(fname, 0)
            if val == 0:
                # Try fN format
                idx = feature_names.index(fname)
                val = scores.get(f'f{idx}', 0)
            feat_scores[fname] = val
        total = sum(feat_scores.values()) or 1
        results[imp_type] = {k: round(v / total * 100, 2) for k, v in feat_scores.items()}
    return results


def permutation_importance(model, X, positions, groups, feature_names, n_repeats=5):
    """Permutation importance: shuffle each feature and measure NDCG drop"""
    rng = np.random.RandomState(42)

    # Baseline NDCG@1
    y_pred_base = model.predict(X)
    y_rel = np.array([3 if p == 1 else 2 if p == 2 else 1 if p == 3 else 0 for p in positions], dtype=np.float32)
    y_true_groups = split_by_groups(y_rel, groups)
    y_pred_groups = split_by_groups(y_pred_base, groups)

    from sklearn.metrics import ndcg_score
    base_ndcgs = []
    for yt, yp in zip(y_true_groups, y_pred_groups):
        if len(yt) < 2:
            continue
        try:
            base_ndcgs.append(ndcg_score([yt], [yp], k=1))
        except ValueError:
            continue
    baseline_ndcg = np.mean(base_ndcgs) if base_ndcgs else 0

    print(f"Baseline NDCG@1: {baseline_ndcg:.4f}")

    importances = {}
    for fi, fname in enumerate(feature_names):
        drops = []
        for _ in range(n_repeats):
            X_perm = X.copy()
            X_perm[:, fi] = rng.permutation(X_perm[:, fi])
            y_pred_perm = model.predict(X_perm)
            perm_groups = split_by_groups(y_pred_perm, groups)
            perm_ndcgs = []
            for yt, yp in zip(y_true_groups, perm_groups):
                if len(yt) < 2:
                    continue
                try:
                    perm_ndcgs.append(ndcg_score([yt], [yp], k=1))
                except ValueError:
                    continue
            perm_ndcg = np.mean(perm_ndcgs) if perm_ndcgs else 0
            drops.append(baseline_ndcg - perm_ndcg)
        importances[fname] = {
            'mean_drop': round(float(np.mean(drops)), 6),
            'std_drop': round(float(np.std(drops)), 6),
        }
        if (fi + 1) % 10 == 0:
            print(f"  {fi + 1}/{len(feature_names)} features done...")

    return importances, baseline_ndcg


def analyze_winner_feature_values(X, positions, feature_names):
    """Winner vs Loser: raw feature value comparison"""
    winner_mask = positions == 1
    loser_mask = positions > 3

    if np.sum(winner_mask) == 0 or np.sum(loser_mask) == 0:
        return []

    results = []
    for fi, fname in enumerate(feature_names):
        w_mean = float(np.mean(X[winner_mask, fi]))
        l_mean = float(np.mean(X[loser_mask, fi]))
        w_std = float(np.std(X[winner_mask, fi]))
        l_std = float(np.std(X[loser_mask, fi]))
        # Effect size (Cohen's d)
        pooled_std = np.sqrt((w_std**2 + l_std**2) / 2) if (w_std + l_std) > 0 else 1
        cohens_d = (w_mean - l_mean) / pooled_std if pooled_std > 0 else 0
        results.append({
            'feature': fname,
            'winner_mean': round(w_mean, 4),
            'loser_mean': round(l_mean, 4),
            'cohens_d': round(float(cohens_d), 4),
        })

    results.sort(key=lambda x: -abs(x['cohens_d']))
    return results


def print_importance_table(feature_names, gain, weight, cover, perm, label=""):
    """Unified importance table"""
    prefix = f"[{label}] " if label else ""

    # Composite score: 40% gain + 30% permutation + 20% cover + 10% weight
    composite = {}
    for fname in feature_names:
        g = gain.get(fname, 0)
        w = weight.get(fname, 0)
        c = cover.get(fname, 0)
        p_drop = perm.get(fname, {}).get('mean_drop', 0) if perm else 0
        # Normalize perm drop to percentage scale
        max_drop = max((v.get('mean_drop', 0) for v in perm.values()), default=1) if perm else 1
        p_pct = (p_drop / max_drop * 100) if max_drop > 0 else 0
        composite[fname] = 0.4 * g + 0.3 * p_pct + 0.2 * c + 0.1 * w

    ranked = sorted(composite.items(), key=lambda x: -x[1])

    print(f"\n{prefix}Feature Importance (Composite: 40%gain + 30%perm + 20%cover + 10%weight)")
    print(f"{'Rank':<5} {'Feature':<30} {'Gain%':>8} {'Perm':>10} {'Cover%':>8} {'Score':>8}")
    print("-" * 75)

    results = []
    for rank, (fname, score) in enumerate(ranked):
        g = gain.get(fname, 0)
        p = perm.get(fname, {}).get('mean_drop', 0) if perm else 0
        c = cover.get(fname, 0)
        results.append({
            'rank': rank + 1,
            'feature': fname,
            'gain_pct': g,
            'perm_drop': round(p, 6),
            'cover_pct': c,
            'composite_score': round(score, 2),
        })
        if rank < 20:
            print(f"{rank+1:<5} {fname:<30} {g:>7.2f}% {p:>+10.6f} {c:>7.2f}% {score:>7.2f}")

    dead = [r for r in results if r['composite_score'] < 1.0]
    if dead:
        print(f"\n{prefix}Dead features (composite < 1.0): {len(dead)}")
        for r in dead:
            print(f"  - {r['feature']} (score={r['composite_score']:.2f}, gain={r['gain_pct']:.2f}%, perm={r['perm_drop']:+.6f})")

    return results


def main():
    print(f"Loading: {LOCAL_DATA_FILE}")
    with open(LOCAL_DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    data_feature_names = data["feature_names"]
    rows = data["rows"]
    print(f"Samples: {len(rows)}, Data features: {len(data_feature_names)}")

    # Align features to model's feature_names.json (model may use fewer features)
    model_feat_path = os.path.join(MODEL_DIR, "feature_names.json")
    if os.path.exists(model_feat_path):
        with open(model_feat_path, "r", encoding="utf-8") as f:
            feature_names = json.load(f)
        print(f"Model features: {len(feature_names)}")
        # Build index map: model feature -> data feature index
        feat_indices = []
        for fn in feature_names:
            if fn in data_feature_names:
                feat_indices.append(data_feature_names.index(fn))
            else:
                print(f"WARNING: model feature '{fn}' not found in data, using zeros")
                feat_indices.append(-1)
    else:
        feature_names = data_feature_names
        feat_indices = list(range(len(feature_names)))

    X_full = np.array([r["features"] for r in rows], dtype=np.float32)
    # Select only features the model uses
    X = np.zeros((len(rows), len(feature_names)), dtype=np.float32)
    for col, di in enumerate(feat_indices):
        if di >= 0:
            X[:, col] = X_full[:, di]
    print(f"Feature matrix aligned: {X.shape}")
    race_ids = [r["race_id"] for r in rows]
    positions = np.array([r["position"] for r in rows], dtype=np.int32)

    # Time-series split
    sorted_indices = sorted(range(len(rows)), key=lambda i: race_ids[i])
    split_train = int(len(sorted_indices) * 0.70)
    split_cal = int(len(sorted_indices) * 0.85)
    test_idx = sorted_indices[split_cal:]
    test_ordered, groups_test = build_race_groups(race_ids, test_idx)
    X_test = X[test_ordered]
    positions_test = positions[test_ordered]

    # Subsample for permutation speed
    max_perm_samples = 3000
    rng = np.random.RandomState(42)
    if len(X_test) > max_perm_samples:
        idx = rng.choice(len(X_test), max_perm_samples, replace=False)
        X_perm = X_test[idx]
        pos_perm = positions_test[idx]
        # Rebuild groups for subsampled data (treat as single large group for permutation)
        _, groups_perm = np.array(range(len(X_perm))), np.array([len(X_perm)])
    else:
        X_perm = X_test
        pos_perm = positions_test
        groups_perm = groups_test

    report = {
        'total_samples': len(rows),
        'test_samples': len(X_test),
        'perm_samples': len(X_perm),
        'feature_count': len(feature_names),
        'feature_names': feature_names,
    }

    # === Global Model ===
    xgb_path = os.path.join(MODEL_DIR, "xgb_ranker.json")
    if not os.path.exists(xgb_path):
        print("ERROR: xgb_ranker.json not found")
        sys.exit(1)

    print("\n" + "=" * 75)
    print("=== XGBoost Global Model ===")
    print("=" * 75)
    model = xgb.XGBRanker()
    model.load_model(xgb_path)

    # Native importance
    native = get_native_importance(model, feature_names)

    # Permutation importance
    print("\nPermutation importance (n_repeats=5)...")
    perm_imp, baseline = permutation_importance(model, X_perm, pos_perm, groups_perm, feature_names)

    # Composite table
    global_results = print_importance_table(
        feature_names, native['gain'], native['weight'], native['cover'], perm_imp, "Global"
    )

    # Winner vs Loser
    wl = analyze_winner_feature_values(X_test, positions_test, feature_names)
    print(f"\nWinner vs Loser (Cohen's d, Top 10):")
    print(f"{'Feature':<30} {'Winner':>10} {'Loser':>10} {'d':>8}")
    print("-" * 62)
    for r in wl[:10]:
        print(f"{r['feature']:<30} {r['winner_mean']:>10.4f} {r['loser_mean']:>10.4f} {r['cohens_d']:>+8.4f}")

    report['xgb_global'] = {
        'baseline_ndcg1': round(baseline, 4),
        'importance': global_results,
        'native_gain': native['gain'],
        'native_cover': native['cover'],
        'permutation': perm_imp,
        'winner_vs_loser': wl[:20],
    }

    # === Category Models ===
    # trackType_encoded/distance はモデル特徴量に含まれない場合があるので行メタデータから取得
    sample_cats = np.array([
        categorize_race(r.get('track_type_encoded', -1), r.get('distance_val', 0)) for r in rows
    ], dtype=object)

    report['category_analysis'] = {}
    for cat_name in CATEGORIES:
        cat_path = os.path.join(MODEL_DIR, f"xgb_ranker_{cat_name}.json")
        if not os.path.exists(cat_path):
            continue

        cat_mask = sample_cats == cat_name
        cat_test = [i for i in test_idx if cat_mask[i]]
        if len(cat_test) < 100:
            print(f"\n{cat_name}: insufficient ({len(cat_test)}) - skip")
            continue

        cat_ordered, cat_groups = build_race_groups(race_ids, cat_test)
        X_cat = X[cat_ordered]
        pos_cat = positions[cat_ordered]

        cat_max = min(1500, len(X_cat))
        if len(X_cat) > cat_max:
            ci = rng.choice(len(X_cat), cat_max, replace=False)
            X_cat_sub = X_cat[ci]
            pos_cat_sub = pos_cat[ci]
            cat_groups_sub = np.array([len(X_cat_sub)])
        else:
            X_cat_sub = X_cat
            pos_cat_sub = pos_cat
            cat_groups_sub = cat_groups

        print(f"\n{'=' * 75}")
        print(f"=== Category: {cat_name} ({len(X_cat_sub)} samples) ===")
        print(f"{'=' * 75}")

        cat_model = xgb.XGBRanker()
        cat_model.load_model(cat_path)
        cat_native = get_native_importance(cat_model, feature_names)

        print(f"Permutation importance...")
        cat_perm, cat_base = permutation_importance(
            cat_model, X_cat_sub, pos_cat_sub, cat_groups_sub, feature_names, n_repeats=3
        )

        cat_results = print_importance_table(
            feature_names, cat_native['gain'], cat_native['weight'], cat_native['cover'],
            cat_perm, cat_name
        )

        report['category_analysis'][cat_name] = {
            'sample_count': len(X_cat_sub),
            'baseline_ndcg1': round(cat_base, 4),
            'importance': cat_results,
        }

    # === Cross-Category Comparison ===
    print(f"\n{'=' * 75}")
    print(f"=== Cross-Category Feature Divergence ===")
    print(f"{'=' * 75}")

    for feat in feature_names:
        cat_scores = {}
        for cn, cd in report['category_analysis'].items():
            for r in cd['importance']:
                if r['feature'] == feat:
                    cat_scores[cn] = r['composite_score']
                    break
        if len(cat_scores) >= 2:
            mx, mn = max(cat_scores.values()), min(cat_scores.values())
            if mx - mn > 3.0:
                best = max(cat_scores, key=cat_scores.get)
                worst = min(cat_scores, key=cat_scores.get)
                print(f"  {feat}: {best}={mx:.1f} vs {worst}={mn:.1f} (gap {mx-mn:.1f})")

    # === Dead features ===
    dead = sorted({r['feature'] for r in global_results if r['composite_score'] < 1.0})
    report['dead_features'] = dead
    report['top5_features'] = [r['feature'] for r in global_results[:5]]

    print(f"\n{'=' * 75}")
    print(f"=== Final Recommendations ===")
    print(f"{'=' * 75}")
    print(f"Top 5: {report['top5_features']}")
    print(f"Dead ({len(dead)}): {dead}")

    # Save
    report_path = os.path.join(MODEL_DIR, "shap_report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\nReport saved: {report_path}")


if __name__ == "__main__":
    main()
