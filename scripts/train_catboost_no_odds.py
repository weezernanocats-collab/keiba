"""
CatBoost No-Odds Ranker 学習スクリプト

v14.0: 特徴量プルーニング適用 — 56→42特徴量
feature_selection_result.jsonで選定された42特徴量のみ使用。

出力:
  model/catboost_no_odds.json (TS互換)
  model/catboost_no_odds_calibration.json
  model/feature_names_no_odds.json
"""

import json
import math
import os
import sys

import numpy as np
from catboost import CatBoostRanker, Pool
from sklearn.metrics import ndcg_score
from sklearn.isotonic import IsotonicRegression

MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "model")
LOCAL_DATA_FILE = os.path.join(MODEL_DIR, "training_data.json")

ODDS_FEATURES = {
    "popularity",
    "oddsLogTransform",
    "popularityRatio",
    "relativeOdds",
    "avgPastOdds",
}

# feature_names.json (本番推論で使う全特徴量)
PROD_FEATURE_NAMES_FILE = os.path.join(MODEL_DIR, "feature_names.json")
# feature_selection_result.json (プルーニング済み42特徴量)
FEATURE_SELECTION_FILE = os.path.join(MODEL_DIR, "feature_selection_result.json")


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


def expand_group_weights_to_samples(groups, group_weights):
    sample_weights = []
    for gi, g in enumerate(groups):
        w = group_weights[gi] if gi < len(group_weights) else 1.0
        sample_weights.extend([w] * int(g))
    return np.array(sample_weights, dtype=np.float32)


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
            score = ndcg_score([y_true], [y_pred], k=k)
            ndcgs.append(score)
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


def compute_ece(probs, actuals, n_bins=10):
    bin_boundaries = np.linspace(0, 1, n_bins + 1)
    ece = 0.0
    for i in range(n_bins):
        if i == n_bins - 1:
            mask = (probs >= bin_boundaries[i]) & (probs <= bin_boundaries[i + 1])
        else:
            mask = (probs >= bin_boundaries[i]) & (probs < bin_boundaries[i + 1])
        count = np.sum(mask)
        if count == 0:
            continue
        avg_pred = float(np.mean(probs[mask]))
        avg_actual = float(np.mean(actuals[mask]))
        ece += (count / len(probs)) * abs(avg_pred - avg_actual)
    return float(ece)


def compute_race_weights(positions, odds_data, ordered_indices, groups):
    group_weights = np.ones(len(groups), dtype=np.float32)
    offset = 0
    for gi, g in enumerate(groups):
        g = int(g)
        group_indices = ordered_indices[offset:offset + g]
        group_positions = positions[group_indices]
        group_odds = odds_data[group_indices]
        winner_mask = group_positions == 1
        if np.any(winner_mask):
            winner_odds = float(group_odds[winner_mask][0])
            group_weights[gi] = math.log1p(max(winner_odds, 1.0)) if winner_odds > 0 else 1.0
        offset += g
    return group_weights


def export_catboost_for_ts(model, feature_names, filepath):
    tmp_json = filepath + ".tmp.json"
    model.save_model(tmp_json, format='json')
    with open(tmp_json, 'r', encoding='utf-8') as f:
        cb_json = json.load(f)

    trees = []
    for tree_data in cb_json.get('oblivious_trees', []):
        splits = tree_data.get('splits', [])
        leaf_values = tree_data.get('leaf_values', [])
        tree_splits = []
        for split in splits:
            if 'float_feature_index' in split:
                tree_splits.append({
                    'feature_index': split['float_feature_index'],
                    'threshold': split['border'],
                })
            elif 'ctr_target_border_idx' in split:
                tree_splits.append({
                    'feature_index': split.get('float_feature_index', 0),
                    'threshold': split.get('border', 0),
                })
        trees.append({
            'splits': tree_splits,
            'leaf_values': leaf_values,
        })

    export_data = {
        'model_type': 'catboost_oblivious',
        'tree_count': len(trees),
        'feature_count': len(feature_names),
        'scale': cb_json.get('scale_and_bias', [1.0, [0.0]])[0] if 'scale_and_bias' in cb_json else 1.0,
        'bias': cb_json.get('scale_and_bias', [1.0, [0.0]])[1][0] if 'scale_and_bias' in cb_json else 0.0,
        'trees': trees,
    }

    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(export_data, f, ensure_ascii=False)

    os.remove(tmp_json)
    print(f"No-Odds TS model saved: {filepath} ({len(trees)} trees)")
    return export_data


def fit_calibration(model, X_cal, positions_cal, groups_cal):
    query_ids = groups_to_query_ids(groups_cal)
    pool = Pool(data=X_cal, group_id=query_ids)
    raw_scores = model.predict(pool)

    softmax_probs = []
    actual_wins = []
    offset = 0
    for g in groups_cal:
        g = int(g)
        group_raw = raw_scores[offset:offset + g]
        group_pos = positions_cal[offset:offset + g]
        probs = softmax_np(group_raw)
        for i in range(g):
            softmax_probs.append(float(probs[i]))
            actual_wins.append(1 if int(group_pos[i]) == 1 else 0)
        offset += g

    softmax_probs = np.array(softmax_probs)
    actual_wins = np.array(actual_wins)

    ir = IsotonicRegression(out_of_bounds='clip')
    ir.fit(softmax_probs, actual_wins)

    cal_probs = ir.predict(softmax_probs)
    brier_before = float(np.mean((softmax_probs - actual_wins) ** 2))
    brier_after = float(np.mean((cal_probs - actual_wins) ** 2))
    ece_before = compute_ece(softmax_probs, actual_wins)
    ece_after = compute_ece(cal_probs, actual_wins)

    improvement = (1 - brier_after / brier_before) * 100 if brier_before > 0 else 0
    print(f"  Brier: {brier_before:.6f} -> {brier_after:.6f} ({improvement:+.1f}%)")
    print(f"  ECE:   {ece_before:.4f} -> {ece_after:.4f}")

    return ir


def main():
    print("=== CatBoost No-Odds Ranker ===\n")

    # Load pruned feature set from feature selection experiment
    if os.path.exists(FEATURE_SELECTION_FILE):
        with open(FEATURE_SELECTION_FILE, 'r', encoding='utf-8') as f:
            fs_result = json.load(f)
        no_odds_features = fs_result['best_features']
        print(f"Using pruned features from feature_selection_result.json: {len(no_odds_features)}")
    else:
        # Fallback: all non-odds features from prod feature_names.json
        with open(PROD_FEATURE_NAMES_FILE, 'r', encoding='utf-8') as f:
            prod_feature_names = json.load(f)
        no_odds_features = [fn for fn in prod_feature_names if fn not in ODDS_FEATURES]
        print(f"No feature selection result found, using all no-odds: {len(no_odds_features)}")
    print(f"No-odds features: {len(no_odds_features)}")

    # Load training data
    print(f"\nLoading: {LOCAL_DATA_FILE}")
    with open(LOCAL_DATA_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)

    train_feature_names = data["feature_names"]
    rows = data["rows"]
    print(f"Training data: {len(rows)} samples, {len(train_feature_names)} features")

    # Map: for each no-odds feature, find its index in training data
    no_odds_col_indices = []
    for fn in no_odds_features:
        if fn in train_feature_names:
            no_odds_col_indices.append(train_feature_names.index(fn))
        else:
            print(f"WARNING: {fn} not in training data, skipping")

    # Rebuild no_odds_features to only include those actually in training data
    no_odds_features_actual = [no_odds_features[i] for i in range(len(no_odds_features))
                                if no_odds_features[i] in train_feature_names]
    no_odds_col_indices_final = [train_feature_names.index(fn) for fn in no_odds_features_actual]

    print(f"Final no-odds features: {len(no_odds_features_actual)}")

    # Build feature matrix with only non-odds columns
    X_full = np.array([r["features"] for r in rows], dtype=np.float32)
    X = X_full[:, no_odds_col_indices_final]
    print(f"Feature matrix shape: {X.shape}")

    race_ids = [r["race_id"] for r in rows]
    positions = np.array([r["position"] for r in rows], dtype=np.int32)
    odds_data = np.array([r.get("odds") or 0 for r in rows], dtype=np.float32)
    recency_data = np.array([r.get("recency_weight", 1.0) for r in rows], dtype=np.float32)
    has_odds = int(np.sum(odds_data > 0)) > len(odds_data) // 2

    # Time-series split (same as train_catboost.py)
    sorted_indices = sorted(range(len(rows)), key=lambda i: race_ids[i])
    split_train = int(len(sorted_indices) * 0.70)
    split_cal = int(len(sorted_indices) * 0.85)
    train_idx = sorted_indices[:split_train]
    cal_idx = sorted_indices[split_train:split_cal]
    test_idx = sorted_indices[split_cal:]

    print(f"Train: {len(train_idx)}, Cal: {len(cal_idx)}, Test: {len(test_idx)}")

    y_standard = np.array([position_to_relevance(p) for p in positions], dtype=np.float32)

    train_ordered, groups_train = build_race_groups(race_ids, train_idx)
    cal_ordered, groups_cal = build_race_groups(race_ids, cal_idx)
    test_ordered, groups_test = build_race_groups(race_ids, test_idx)

    X_train = X[train_ordered]
    X_cal = X[cal_ordered]
    X_test = X[test_ordered]

    y_train = y_standard[train_ordered]
    y_cal = y_standard[cal_ordered]
    y_test = y_standard[test_ordered]
    positions_cal = positions[cal_ordered]
    positions_test = positions[test_ordered]

    # Weights
    train_weights = None
    if has_odds:
        train_weights = compute_race_weights(positions, odds_data, train_ordered, groups_train)
        recency_group_weights = []
        offset = 0
        for g in groups_train:
            g = int(g)
            group_recency = recency_data[train_ordered[offset:offset + g]]
            recency_group_weights.append(float(np.mean(group_recency)))
            offset += g
        recency_group_weights = np.array(recency_group_weights, dtype=np.float32)
        train_weights = train_weights * recency_group_weights
        print("Odds-weighted x recency enabled")

    # Train
    print("\n=== Training No-Odds CatBoost ===")
    train_query_ids = groups_to_query_ids(groups_train)
    eval_query_ids = groups_to_query_ids(groups_cal)

    train_pool = Pool(
        data=X_train,
        label=y_train,
        group_id=train_query_ids,
        weight=expand_group_weights_to_samples(groups_train, train_weights)
            if train_weights is not None else None,
    )
    eval_pool = Pool(
        data=X_cal,
        label=y_cal,
        group_id=eval_query_ids,
    )

    # v14.1: YetiRank に変更
    # YetiRankはリストワイズに近い損失関数で、段階ラベル(0-3)を活用可能
    # PairLogitPairwiseはsample_weightを無視する問題があった
    model = CatBoostRanker(
        iterations=1500,
        learning_rate=0.02,
        depth=6,
        loss_function='YetiRank',
        eval_metric='NDCG:top=1',
        random_seed=42,
        verbose=100,
        early_stopping_rounds=75,
        l2_leaf_reg=3.0,
        bagging_temperature=0.8,
        border_count=128,
        random_strength=0.5,
    )

    model.fit(train_pool, eval_set=eval_pool)

    # Evaluate
    print("\n=== Evaluation ===")
    for label, X_ev, y_ev, groups_ev in [
        ("Val", X_cal, y_cal, groups_cal),
        ("Test", X_test, y_test, groups_test),
    ]:
        query_ids = groups_to_query_ids(groups_ev)
        pool = Pool(data=X_ev, group_id=query_ids)
        y_pred = model.predict(pool)
        y_true_groups = split_by_groups(y_ev, groups_ev)
        y_pred_groups = split_by_groups(y_pred, groups_ev)
        ndcg1 = calc_ndcg_at_k(y_true_groups, y_pred_groups, k=1)
        top1 = calc_top_k_accuracy(y_true_groups, y_pred_groups, k=1)
        top3 = calc_top_k_accuracy(y_true_groups, y_pred_groups, k=3)
        print(f"  [{label}] NDCG@1: {ndcg1:.4f}, Top-1: {top1:.4f}, Top-3: {top3:.4f}")

    # Calibration
    print("\n=== Calibration ===")
    ir = fit_calibration(model, X_cal, positions_cal, groups_cal)

    # Save model
    os.makedirs(MODEL_DIR, exist_ok=True)

    export_catboost_for_ts(
        model, no_odds_features_actual,
        os.path.join(MODEL_DIR, "catboost_no_odds.json"),
    )

    # Save calibration
    cal_data = {
        'x_thresholds': ir.X_thresholds_.tolist(),
        'y_values': ir.y_thresholds_.tolist(),
    }
    with open(os.path.join(MODEL_DIR, "catboost_no_odds_calibration.json"), 'w', encoding='utf-8') as f:
        json.dump(cal_data, f, ensure_ascii=False, indent=2)
    print(f"Calibration saved: catboost_no_odds_calibration.json")

    # Save feature names
    with open(os.path.join(MODEL_DIR, "feature_names_no_odds.json"), 'w', encoding='utf-8') as f:
        json.dump(no_odds_features_actual, f, ensure_ascii=False, indent=2)
    print(f"Feature names saved: feature_names_no_odds.json ({len(no_odds_features_actual)} features)")

    # Quick disagreement analysis on test set
    print("\n=== Disagreement Analysis (Test Set) ===")
    test_query_ids = groups_to_query_ids(groups_test)
    test_pool = Pool(data=X_test, group_id=test_query_ids)
    test_pred = model.predict(test_pool)

    # Compare AI Top-1 vs actual favorite (need odds from training data)
    # Build per-race analysis on test set
    offset = 0
    agree = 0
    disagree = 0
    disagree_ai_wins = 0
    disagree_fav_wins = 0
    disagree_neither_wins = 0

    for g in groups_test:
        g = int(g)
        group_indices = test_ordered[offset:offset + g]
        group_pred = test_pred[offset:offset + g]
        group_pos = positions[group_indices]
        group_odds = odds_data[group_indices]

        ai_top1 = np.argmax(group_pred)
        if np.any(group_odds > 0):
            fav_idx = np.argmin(np.where(group_odds > 0, group_odds, 9999))
        else:
            fav_idx = ai_top1  # fallback

        if ai_top1 == fav_idx:
            agree += 1
        else:
            disagree += 1
            if group_pos[ai_top1] == 1:
                disagree_ai_wins += 1
            elif group_pos[fav_idx] == 1:
                disagree_fav_wins += 1
            else:
                disagree_neither_wins += 1

        offset += g

    total_races = agree + disagree
    print(f"  Total races: {total_races}")
    print(f"  Agree: {agree} ({agree/total_races*100:.1f}%)")
    print(f"  Disagree: {disagree} ({disagree/total_races*100:.1f}%)")
    if disagree > 0:
        print(f"    AI wins: {disagree_ai_wins} ({disagree_ai_wins/disagree*100:.1f}%)")
        print(f"    Fav wins: {disagree_fav_wins} ({disagree_fav_wins/disagree*100:.1f}%)")
        print(f"    Neither: {disagree_neither_wins} ({disagree_neither_wins/disagree*100:.1f}%)")

    # EV-filtered ROI simulation on test set
    print("\n=== EV-Filtered ROI Simulation (Test Set) ===")
    offset = 0
    ev_results = {1.0: {"bets": 0, "inv": 0, "ret": 0}, 1.2: {"bets": 0, "inv": 0, "ret": 0}, 1.5: {"bets": 0, "inv": 0, "ret": 0}}

    for g in groups_test:
        g = int(g)
        group_indices = test_ordered[offset:offset + g]
        group_pred = test_pred[offset:offset + g]
        group_pos = positions[group_indices]
        group_odds = odds_data[group_indices]

        # Softmax to get calibrated probabilities
        probs = softmax_np(group_pred)
        # Apply isotonic regression calibration
        cal_probs = ir.predict(probs)

        for i in range(g):
            horse_odds = float(group_odds[i])
            if horse_odds <= 0:
                continue
            horse_prob = float(cal_probs[i])
            horse_pos = int(group_pos[i])
            ev = horse_prob * horse_odds

            for threshold in ev_results:
                if ev >= threshold and horse_odds >= 3 and horse_odds <= 30:
                    ev_results[threshold]["bets"] += 1
                    ev_results[threshold]["inv"] += 100
                    if horse_pos == 1:
                        ev_results[threshold]["ret"] += int(100 * horse_odds)

        offset += g

    for threshold, r in sorted(ev_results.items()):
        roi = r["ret"] / r["inv"] * 100 if r["inv"] > 0 else 0
        hit = sum(1 for _ in range(r["bets"]) if False)  # placeholder
        print(f"  EV>={threshold:.1f} (odds 3-30): {r['bets']} bets, ROI={roi:.1f}%, invest={r['inv']}, return={r['ret']}")

    print("\n=== Done ===")


if __name__ == "__main__":
    main()
