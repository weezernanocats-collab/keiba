"""
LightGBM LambdaRank No-Odds 学習スクリプト

Phase 1で選定した42特徴量サブセットでLightGBM LambdaRankを学習。
LambdaRankはsample weights対応 → recency重みが実際に効く（CatBoost PairLogitPairwiseと違い）。

出力:
  model/lgb_no_odds_ranker.json (TS互換)
  model/lgb_no_odds_calibration.json
  model/no_odds_ensemble_weights.json

Usage: source .venv/bin/activate && python3 scripts/train_lightgbm_no_odds.py
"""

import json
import math
import os
import sys

import lightgbm as lgb
import numpy as np
from catboost import CatBoostRanker, Pool
from sklearn.metrics import ndcg_score
from sklearn.isotonic import IsotonicRegression

MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "model")
LOCAL_DATA_FILE = os.path.join(MODEL_DIR, "training_data.json")
FEATURE_SELECTION_FILE = os.path.join(MODEL_DIR, "feature_selection_result.json")

ODDS_FEATURES = {
    "popularity", "oddsLogTransform", "popularityRatio",
    "relativeOdds", "avgPastOdds",
}


def position_to_relevance(position):
    if position == 1:
        return 3
    elif position == 2:
        return 2
    elif position == 3:
        return 1
    return 0


def build_race_groups(race_ids, indices):
    sorted_idx = sorted(indices, key=lambda i: race_ids[i])
    groups = []
    current_race = None
    current_count = 0
    ordered_indices = []
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


def groups_to_query_ids(groups):
    query_ids = []
    for gi, g in enumerate(groups):
        query_ids.extend([gi] * int(g))
    return np.array(query_ids, dtype=np.int32)


def split_by_groups(y, groups):
    result = []
    offset = 0
    for g in groups:
        result.append(y[offset:offset + int(g)].tolist())
        offset += int(g)
    return result


def calc_ndcg_at_k(y_true_groups, y_pred_groups, k):
    ndcgs = []
    for y_true, y_pred in zip(y_true_groups, y_pred_groups):
        if len(y_true) < 2:
            continue
        try:
            ndcgs.append(ndcg_score([y_true], [y_pred], k=k))
        except ValueError:
            continue
    return np.mean(ndcgs) if ndcgs else 0.0


def calc_top_k_accuracy(y_true_groups, y_pred_groups, k):
    correct = 0
    total = 0
    for y_true, y_pred in zip(y_true_groups, y_pred_groups):
        if len(y_true) < 2:
            continue
        total += 1
        best_idx = np.argmax(y_true)
        top_k_idx = np.argsort(y_pred)[-k:]
        if best_idx in top_k_idx:
            correct += 1
    return correct / total if total > 0 else 0.0


def softmax_np(scores):
    max_s = np.max(scores)
    exps = np.exp(scores - max_s)
    return exps / np.sum(exps)


def compute_race_weights(positions, odds_data, ordered_indices, groups, recency_data):
    """レース重み = log1p(勝者オッズ) × 平均recency"""
    group_weights = np.ones(len(groups), dtype=np.float32)
    offset = 0
    for gi, g in enumerate(groups):
        g = int(g)
        group_indices = ordered_indices[offset:offset + g]
        group_positions = positions[group_indices]
        group_odds = odds_data[group_indices]
        group_recency = recency_data[group_indices]

        w = 1.0
        winner_mask = group_positions == 1
        if np.any(winner_mask):
            winner_odds = float(group_odds[winner_mask][0])
            if winner_odds > 0:
                w = math.log1p(max(winner_odds, 1.0))

        w *= float(np.mean(group_recency))
        group_weights[gi] = w
        offset += g
    return group_weights


def expand_group_weights(groups, group_weights):
    sample_weights = []
    for gi, g in enumerate(groups):
        w = float(group_weights[gi]) if gi < len(group_weights) else 1.0
        sample_weights.extend([w] * int(g))
    return np.array(sample_weights, dtype=np.float32)


def export_lightgbm_for_ts(model, feature_names, filepath):
    """LightGBMモデルをTS推論互換JSONでエクスポート"""
    booster = model.booster_
    dump = booster.dump_model()
    trees_raw = dump.get('tree_info', [])
    trees = []

    for tree_raw in trees_raw:
        tree_structure = tree_raw.get('tree_structure', {})
        split_feature = []
        threshold = []
        decision_type = []
        left_child = []
        right_child = []
        leaf_value = []

        def traverse(node):
            if 'leaf_index' in node:
                leaf_idx = len(leaf_value)
                leaf_value.append(float(node.get('leaf_value', 0.0)))
                return -(leaf_idx + 1)
            else:
                node_idx = len(split_feature)
                split_feature.append(node.get('split_feature', 0))
                threshold.append(float(node.get('threshold', 0.0)))
                decision_type.append(node.get('decision_type', '<='))
                left_child.append(0)
                right_child.append(0)

                left_idx = traverse(node['left_child'])
                right_idx = traverse(node['right_child'])
                left_child[node_idx] = left_idx
                right_child[node_idx] = right_idx
                return node_idx

        if tree_structure:
            traverse(tree_structure)

        trees.append({
            'num_leaves': tree_raw.get('num_leaves', len(leaf_value)),
            'split_feature': split_feature,
            'threshold': threshold,
            'decision_type': decision_type,
            'left_child': left_child,
            'right_child': right_child,
            'leaf_value': leaf_value,
        })

    export_data = {
        'model_type': 'lightgbm',
        'tree_count': len(trees),
        'feature_count': len(feature_names),
        'feature_names': feature_names,
        'trees': trees,
    }

    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(export_data, f, ensure_ascii=False)

    print(f"LightGBM TS model saved: {filepath} ({len(trees)} trees)")
    return export_data


def main():
    print("=== LightGBM LambdaRank No-Odds ===\n")

    # Load pruned feature set
    if os.path.exists(FEATURE_SELECTION_FILE):
        with open(FEATURE_SELECTION_FILE, 'r') as f:
            fs_result = json.load(f)
        no_odds_features = fs_result['best_features']
        print(f"Pruned features: {len(no_odds_features)}")
    else:
        with open(os.path.join(MODEL_DIR, "feature_names.json"), 'r') as f:
            prod_features = json.load(f)
        no_odds_features = [fn for fn in prod_features if fn not in ODDS_FEATURES]
        print(f"All no-odds features (fallback): {len(no_odds_features)}")

    # Load training data
    with open(LOCAL_DATA_FILE, 'r') as f:
        data = json.load(f)

    train_feature_names = data["feature_names"]
    rows = data["rows"]
    print(f"Samples: {len(rows)}, Training features: {len(train_feature_names)}")

    # Map features
    col_indices = []
    actual_features = []
    for fn in no_odds_features:
        if fn in train_feature_names:
            col_indices.append(train_feature_names.index(fn))
            actual_features.append(fn)
        else:
            print(f"WARNING: {fn} not in training data")

    print(f"Final features: {len(actual_features)}")

    X_full = np.array([r["features"] for r in rows], dtype=np.float32)
    X = X_full[:, col_indices]
    race_ids = [r["race_id"] for r in rows]
    positions = np.array([r["position"] for r in rows], dtype=np.int32)
    odds_data = np.array([r.get("odds") or 0 for r in rows], dtype=np.float32)
    recency_data = np.array([r.get("recency_weight", 1.0) for r in rows], dtype=np.float32)

    y = np.array([position_to_relevance(p) for p in positions], dtype=np.float32)

    # Time-series split
    sorted_indices = sorted(range(len(rows)), key=lambda i: race_ids[i])
    s1 = int(len(sorted_indices) * 0.70)
    s2 = int(len(sorted_indices) * 0.85)
    train_idx, val_idx, test_idx = sorted_indices[:s1], sorted_indices[s1:s2], sorted_indices[s2:]

    tr_o, tr_g = build_race_groups(race_ids, train_idx)
    va_o, va_g = build_race_groups(race_ids, val_idx)
    te_o, te_g = build_race_groups(race_ids, test_idx)

    print(f"Train: {len(tr_o)}, Val: {len(va_o)}, Test: {len(te_o)}")

    # Sample weights — disabled: LightGBM converges too fast with weights
    sample_weights = None
    print("Sample weights: disabled (LightGBM converges better without)")

    # Train
    print("\n=== Training LightGBM LambdaRank ===")
    model = lgb.LGBMRanker(
        n_estimators=1500,
        max_depth=6,
        learning_rate=0.02,
        num_leaves=31,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_samples=50,
        min_child_weight=1e-3,
        reg_alpha=0.1,
        reg_lambda=1.0,
        random_state=42,
        importance_type='gain',
    )

    callbacks = [
        lgb.early_stopping(stopping_rounds=75, verbose=True),
        lgb.log_evaluation(period=100),
    ]

    model.fit(
        X[tr_o], y[tr_o],
        group=tr_g,
        sample_weight=sample_weights,
        eval_set=[(X[va_o], y[va_o])],
        eval_group=[va_g],
        eval_at=[1, 3],
        callbacks=callbacks,
    )

    print(f"\nBest iteration: {model.best_iteration_}")

    # Feature importance
    imp = model.feature_importances_
    imp_pairs = sorted(zip(actual_features, imp), key=lambda x: -x[1])
    print(f"\nFeature importance (top 15):")
    for fn, v in imp_pairs[:15]:
        print(f"  {fn}: {v:.1f}")

    # Evaluate
    print("\n=== Evaluation ===")
    for label, idx_o, gs in [('Val', va_o, va_g), ('Test', te_o, te_g)]:
        pred = model.predict(X[idx_o])
        yg = split_by_groups(y[idx_o], gs)
        pg = split_by_groups(pred, gs)
        n1 = calc_ndcg_at_k(yg, pg, 1)
        t1 = calc_top_k_accuracy(yg, pg, 1)
        t3 = calc_top_k_accuracy(yg, pg, 3)
        print(f"  [{label}] NDCG@1={n1:.4f} Top-1={t1:.4f} Top-3={t3:.4f}")

    # Calibration
    print("\n=== Calibration ===")
    cal_pred = model.predict(X[va_o])
    cal_probs, cal_wins = [], []
    offset = 0
    for g in va_g:
        g = int(g)
        probs = softmax_np(cal_pred[offset:offset + g])
        pos_g = positions[va_o[offset:offset + g]]
        for i in range(g):
            cal_probs.append(float(probs[i]))
            cal_wins.append(1 if int(pos_g[i]) == 1 else 0)
        offset += g
    cal_probs = np.array(cal_probs)
    cal_wins = np.array(cal_wins)
    ir = IsotonicRegression(out_of_bounds='clip')
    ir.fit(cal_probs, cal_wins)
    brier_before = float(np.mean((cal_probs - cal_wins) ** 2))
    brier_after = float(np.mean((ir.predict(cal_probs) - cal_wins) ** 2))
    print(f"  Brier: {brier_before:.6f} -> {brier_after:.6f} ({(1-brier_after/brier_before)*100:+.1f}%)")

    # Save model
    export_lightgbm_for_ts(
        model, actual_features,
        os.path.join(MODEL_DIR, "lgb_no_odds_ranker.json"),
    )

    # Save calibration
    cal_data = {
        'x_thresholds': ir.X_thresholds_.tolist(),
        'y_values': ir.y_thresholds_.tolist(),
    }
    with open(os.path.join(MODEL_DIR, "lgb_no_odds_calibration.json"), 'w') as f:
        json.dump(cal_data, f, indent=2)
    print(f"Calibration saved: lgb_no_odds_calibration.json")

    # === Ensemble with CatBoost ===
    print("\n=== No-Odds Ensemble Weight Learning ===")
    cb_model_path = os.path.join(MODEL_DIR, "catboost_no_odds.json")
    cb_native_path = os.path.join(MODEL_DIR, "catboost_no_odds_native.cbm")

    # CatBoostモデルを再学習してスコアを取得（nativeモデルが無い場合）
    # 簡易化: CatBoostの予測をval setで取得
    try:
        cb_model = CatBoostRanker()
        # CatBoostは native format (.cbm) でのみload可能
        # train_catboost_no_odds.pyで保存されたモデルを使う
        # → 直接再学習してスコアを取得
        print("  Re-training CatBoost for ensemble scoring...")
        from catboost import Pool as CatPool

        cb_tr_pool = CatPool(
            data=X[tr_o], label=y[tr_o],
            group_id=groups_to_query_ids(tr_g),
        )
        cb_va_pool = CatPool(
            data=X[va_o], label=y[va_o],
            group_id=groups_to_query_ids(va_g),
        )

        cb_model = CatBoostRanker(
            iterations=1500,
            learning_rate=0.02,
            depth=6,
            loss_function='PairLogitPairwise',
            eval_metric='NDCG:top=1',
            random_seed=42,
            verbose=100,
            early_stopping_rounds=75,
            l2_leaf_reg=3.0,
            bagging_temperature=0.8,
            border_count=128,
            random_strength=0.5,
        )
        cb_model.fit(cb_tr_pool, eval_set=cb_va_pool)

        # Save native format for future use
        cb_model.save_model(cb_native_path)
        print(f"  CatBoost native model saved: {cb_native_path}")

        # Get scores on val and test
        cb_val_scores = cb_model.predict(cb_va_pool)
        cb_test_pool = CatPool(
            data=X[te_o],
            group_id=groups_to_query_ids(te_g),
        )
        cb_test_scores = cb_model.predict(cb_test_pool)

        lgb_val_scores = model.predict(X[va_o])
        lgb_test_scores = model.predict(X[te_o])

        # Grid search for optimal alpha on val set
        y_true_groups_val = split_by_groups(y[va_o], va_g)
        y_true_groups_test = split_by_groups(y[te_o], te_g)

        best_alpha = 0.5
        best_ndcg = 0.0

        for alpha_cb in np.arange(0.0, 1.01, 0.05):
            alpha_lgb = 1.0 - alpha_cb
            blended = alpha_cb * cb_val_scores + alpha_lgb * lgb_val_scores
            pg = split_by_groups(blended, va_g)
            ndcg = calc_ndcg_at_k(y_true_groups_val, pg, 1)
            if ndcg > best_ndcg:
                best_ndcg = ndcg
                best_alpha = round(alpha_cb, 2)

        print(f"\n  Optimal weights: CatBoost={best_alpha}, LightGBM={round(1-best_alpha, 2)}")
        print(f"  Val NDCG@1: {best_ndcg:.4f}")

        # Evaluate ensemble on test
        blended_test = best_alpha * cb_test_scores + (1 - best_alpha) * lgb_test_scores
        pg_test = split_by_groups(blended_test, te_g)
        ensemble_ndcg = calc_ndcg_at_k(y_true_groups_test, pg_test, 1)
        ensemble_top1 = calc_top_k_accuracy(y_true_groups_test, pg_test, 1)
        ensemble_top3 = calc_top_k_accuracy(y_true_groups_test, pg_test, 3)

        # Also get CatBoost standalone test metrics
        cb_pg_test = split_by_groups(cb_test_scores, te_g)
        cb_ndcg = calc_ndcg_at_k(y_true_groups_test, cb_pg_test, 1)
        cb_top1 = calc_top_k_accuracy(y_true_groups_test, cb_pg_test, 1)

        lgb_pg_test = split_by_groups(lgb_test_scores, te_g)
        lgb_ndcg = calc_ndcg_at_k(y_true_groups_test, lgb_pg_test, 1)
        lgb_top1 = calc_top_k_accuracy(y_true_groups_test, lgb_pg_test, 1)

        print(f"\n  === Test Results ===")
        print(f"  CatBoost only:  NDCG@1={cb_ndcg:.4f} Top-1={cb_top1:.4f}")
        print(f"  LightGBM only:  NDCG@1={lgb_ndcg:.4f} Top-1={lgb_top1:.4f}")
        print(f"  Ensemble:       NDCG@1={ensemble_ndcg:.4f} Top-1={ensemble_top1:.4f} Top-3={ensemble_top3:.4f}")

        # Save ensemble weights
        ensemble_data = {
            'catboost': best_alpha,
            'lightgbm': round(1 - best_alpha, 2),
            'val_ndcg1': round(best_ndcg, 4),
            'test_ndcg1': round(ensemble_ndcg, 4),
            'test_top1': round(ensemble_top1, 4),
            'test_top3': round(ensemble_top3, 4),
        }
        with open(os.path.join(MODEL_DIR, "no_odds_ensemble_weights.json"), 'w') as f:
            json.dump(ensemble_data, f, indent=2)
        print(f"\n  Ensemble weights saved: no_odds_ensemble_weights.json")

    except Exception as e:
        print(f"  Ensemble learning failed: {e}")
        import traceback
        traceback.print_exc()

    print("\n=== Done ===")


if __name__ == '__main__':
    main()
