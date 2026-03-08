"""
CatBoost Ranker 学習スクリプト v1.0

XGBoostと並行して CatBoost YetiRank を学習。
同一データ・同一分割・同一カテゴリ定義を使用。
出力: catboost_ranker.json (TS互換フォーマット)
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
MIN_SAMPLES = 100
MIN_CATEGORY_SAMPLES = 3000

CATEGORIES = {
    'turf_sprint': (0, 0, 1400),
    'turf_mile': (0, 1401, 1800),
    'turf_long': (0, 1901, 99999),
    'dirt_short': (1, 0, 1600),
    'dirt_long': (1, 1601, 99999),
}


# ==================== ユーティリティ (train_model.py と共通) ====================

def categorize_race(track_type_encoded, distance):
    for cat, (tt, d_min, d_max) in CATEGORIES.items():
        if int(track_type_encoded) == tt and d_min <= distance <= d_max:
            return cat
    return None


def position_to_relevance(position):
    if position == 1:
        return 3
    elif position == 2:
        return 2
    elif position == 3:
        return 1
    else:
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


# ==================== CatBoost学習 ====================

def groups_to_query_ids(groups):
    """CatBoost用: group_id配列を生成 (各サンプルにレースIDを割り当て)"""
    query_ids = []
    for gi, g in enumerate(groups):
        query_ids.extend([gi] * int(g))
    return np.array(query_ids, dtype=np.int32)


def expand_group_weights_to_samples(groups, group_weights):
    """グループ単位のウェイトをサンプル単位に展開"""
    sample_weights = []
    for gi, g in enumerate(groups):
        w = group_weights[gi] if gi < len(group_weights) else 1.0
        sample_weights.extend([w] * int(g))
    return np.array(sample_weights, dtype=np.float32)


def train_catboost_ranker(X_train, y_train, groups_train,
                          X_eval, y_eval, groups_eval,
                          sample_weight=None):
    """CatBoost YetiRank を学習"""
    train_query_ids = groups_to_query_ids(groups_train)
    eval_query_ids = groups_to_query_ids(groups_eval)

    train_pool = Pool(
        data=X_train,
        label=y_train,
        group_id=train_query_ids,
        weight=expand_group_weights_to_samples(groups_train, sample_weight)
            if sample_weight is not None else None,
    )
    eval_pool = Pool(
        data=X_eval,
        label=y_eval,
        group_id=eval_query_ids,
    )

    model = CatBoostRanker(
        iterations=500,
        learning_rate=0.05,
        depth=6,
        loss_function='YetiRank',
        eval_metric='NDCG:top=1',
        random_seed=42,
        verbose=100,
        early_stopping_rounds=30,
        l2_leaf_reg=3.0,
        bagging_temperature=0.8,
    )

    model.fit(train_pool, eval_set=eval_pool)
    return model


def evaluate_catboost(model, X, y_relevance, groups, label=""):
    """CatBoostモデルを評価"""
    query_ids = groups_to_query_ids(groups)
    pool = Pool(data=X, group_id=query_ids)
    y_pred = model.predict(pool)

    y_true_groups = split_by_groups(y_relevance, groups)
    y_pred_groups = split_by_groups(y_pred, groups)

    ndcg_1 = calc_ndcg_at_k(y_true_groups, y_pred_groups, k=1)
    ndcg_3 = calc_ndcg_at_k(y_true_groups, y_pred_groups, k=3)
    top1 = calc_top_k_accuracy(y_true_groups, y_pred_groups, k=1)
    top3 = calc_top_k_accuracy(y_true_groups, y_pred_groups, k=3)

    prefix = f"[{label}] " if label else ""
    print(f"{prefix}NDCG@1: {ndcg_1:.4f}, NDCG@3: {ndcg_3:.4f}, Top-1: {top1:.4f}, Top-3: {top3:.4f}")

    return {
        "ndcg_1": round(ndcg_1, 4),
        "ndcg_3": round(ndcg_3, 4),
        "top1_accuracy": round(top1, 4),
        "top3_accuracy": round(top3, 4),
    }


def export_catboost_for_ts(model, feature_names, filepath):
    """CatBoost モデルを TypeScript 推論互換のJSONフォーマットでエクスポート

    CatBoostの内部フォーマット (oblivious trees) をフラットなJSONに変換。
    各ツリーは splits (feature_index, threshold) と leaf_values を持つ。
    """
    # CatBoostのモデルをCBMフォーマットで一度保存し、JSONでも保存
    tmp_json = filepath + ".tmp.json"
    model.save_model(tmp_json, format='json')

    with open(tmp_json, 'r', encoding='utf-8') as f:
        cb_json = json.load(f)

    # oblivious_trees を展開
    trees = []
    oblivious_trees = cb_json.get('oblivious_trees', [])

    for tree_data in oblivious_trees:
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
                # CTR split - skip (handle as pass-through)
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

    # cleanup
    os.remove(tmp_json)

    print(f"CatBoost TS互換モデル保存: {filepath} ({len(trees)} trees)")
    return export_data


def fit_catboost_calibration(model, X_cal, positions_cal, groups_cal):
    """CatBoost用 Isotonic Regression 較正"""
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
    print(f"  CatBoost Brier: {brier_before:.6f} → {brier_after:.6f} ({improvement:+.1f}%)")
    print(f"  CatBoost ECE:   {ece_before:.4f} → {ece_after:.4f}")

    return ir


# ==================== アンサンブル重み学習 ====================

def learn_ensemble_weights(xgb_model_path, catboost_model, X_cal, positions_cal, groups_cal, feature_names):
    """検証セットでXGBoost + CatBoostの最適ブレンド重みを学習"""
    import xgboost as xgb

    xgb_model = xgb.XGBRanker()
    xgb_model.load_model(xgb_model_path)
    xgb_scores = xgb_model.predict(X_cal)

    query_ids = groups_to_query_ids(groups_cal)
    pool = Pool(data=X_cal, group_id=query_ids)
    cb_scores = catboost_model.predict(pool)

    # グリッドサーチで最適重みを探索
    best_weight = 0.5
    best_ndcg = 0.0

    for w in np.arange(0.0, 1.05, 0.05):
        blended = w * xgb_scores + (1 - w) * cb_scores
        y_true_groups = split_by_groups(
            np.array([position_to_relevance(int(p)) for p in positions_cal[np.array(range(len(positions_cal)))]]),
            groups_cal,
        )
        y_pred_groups = split_by_groups(blended, groups_cal)
        ndcg = calc_ndcg_at_k(y_true_groups, y_pred_groups, k=1)
        if ndcg > best_ndcg:
            best_ndcg = ndcg
            best_weight = round(w, 2)

    print(f"\nアンサンブル最適重み: XGBoost={best_weight}, CatBoost={round(1-best_weight, 2)}")
    print(f"最適NDCG@1: {best_ndcg:.4f}")

    return best_weight, round(1 - best_weight, 2)


# ==================== メイン ====================

def main():
    print(f"ローカルデータ読み込み: {LOCAL_DATA_FILE}")
    with open(LOCAL_DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    feature_names = data["feature_names"]
    rows = data["rows"]
    print(f"総サンプル数: {len(rows)}, 特徴量数: {len(feature_names)}")

    if len(rows) < MIN_SAMPLES:
        print(f"サンプル数不足 ({len(rows)} < {MIN_SAMPLES})")
        sys.exit(0)

    X = np.array([r["features"] for r in rows], dtype=np.float32)
    race_ids = [r["race_id"] for r in rows]
    positions = np.array([r["position"] for r in rows], dtype=np.int32)
    odds_data = np.array([r.get("odds") or 0 for r in rows], dtype=np.float32)
    has_odds = int(np.sum(odds_data > 0)) > len(odds_data) // 2

    # 時系列分割 (XGBoostと完全同一)
    sorted_indices = sorted(range(len(rows)), key=lambda i: race_ids[i])
    split_train = int(len(sorted_indices) * 0.70)
    split_cal = int(len(sorted_indices) * 0.85)
    train_idx = sorted_indices[:split_train]
    cal_idx = sorted_indices[split_train:split_cal]
    test_idx = sorted_indices[split_cal:]

    print(f"学習: {len(train_idx)}件, 較正: {len(cal_idx)}件, テスト: {len(test_idx)}件")

    os.makedirs(MODEL_DIR, exist_ok=True)

    y_standard = np.array(
        [position_to_relevance(p) for p in positions], dtype=np.float32
    )

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

    train_weights = None
    if has_odds:
        train_weights = compute_race_weights(positions, odds_data, train_ordered, groups_train)
        print("オッズ加重有効")

    # ==================== グローバルモデル ====================
    print("\n=== CatBoost グローバルモデル学習 ===")
    model = train_catboost_ranker(
        X_train, y_train, groups_train,
        X_cal, y_cal, groups_cal,
        sample_weight=train_weights,
    )

    print("\n--- 検証セット ---")
    val_metrics = evaluate_catboost(model, X_cal, y_cal, groups_cal, "CatBoost-Val")

    # 較正
    print("\n=== CatBoost Platt Scaling ===")
    ir = fit_catboost_calibration(model, X_cal, positions_cal, groups_cal)

    # TS互換フォーマットで保存
    export_catboost_for_ts(
        model, feature_names,
        os.path.join(MODEL_DIR, "catboost_ranker.json"),
    )

    # 較正保存
    cal_data = {
        'x_thresholds': ir.X_thresholds_.tolist(),
        'y_values': ir.y_thresholds_.tolist(),
    }
    with open(os.path.join(MODEL_DIR, "catboost_calibration.json"), 'w', encoding='utf-8') as f:
        json.dump(cal_data, f, ensure_ascii=False, indent=2)
    print(f"CatBoost較正保存: catboost_calibration.json")

    # ==================== カテゴリ別モデル ====================
    print("\n=== CatBoost カテゴリ別モデル ===")

    track_type_idx = feature_names.index('trackType_encoded')
    distance_idx = feature_names.index('distance')

    sample_categories = np.array([
        categorize_race(X[i, track_type_idx], X[i, distance_idx])
        for i in range(len(rows))
    ], dtype=object)

    category_metrics = {}

    for cat_name in CATEGORIES:
        cat_mask = sample_categories == cat_name
        cat_train_idx = [i for i in train_idx if cat_mask[i]]
        cat_cal_idx = [i for i in cal_idx if cat_mask[i]]

        print(f"\n--- {cat_name}: 学習{len(cat_train_idx)}件, 較正{len(cat_cal_idx)}件 ---")

        if len(cat_train_idx) < MIN_CATEGORY_SAMPLES:
            print(f"  サンプル不足 → スキップ")
            continue

        cat_train_ordered, cat_groups_train = build_race_groups(race_ids, cat_train_idx)
        cat_cal_ordered, cat_groups_cal = build_race_groups(race_ids, cat_cal_idx)

        if len(cat_groups_cal) < 10:
            print(f"  較正レース数不足 → スキップ")
            continue

        cat_train_weights = None
        if has_odds:
            cat_train_weights = compute_race_weights(
                positions, odds_data, cat_train_ordered, cat_groups_train
            )

        cat_model = train_catboost_ranker(
            X[cat_train_ordered], y_standard[cat_train_ordered], cat_groups_train,
            X[cat_cal_ordered], y_standard[cat_cal_ordered], cat_groups_cal,
            sample_weight=cat_train_weights,
        )

        cat_val = evaluate_catboost(
            cat_model, X[cat_cal_ordered], y_standard[cat_cal_ordered],
            cat_groups_cal, cat_name,
        )

        cat_filename = f"catboost_ranker_{cat_name}.json"
        export_catboost_for_ts(
            cat_model, feature_names,
            os.path.join(MODEL_DIR, cat_filename),
        )

        category_metrics[cat_name] = cat_val

    # ==================== アンサンブル重み ====================
    xgb_model_path = os.path.join(MODEL_DIR, "xgb_ranker.json")
    ensemble_weights = {'xgb': 0.5, 'catboost': 0.5}

    if os.path.exists(xgb_model_path):
        print("\n=== アンサンブル重み学習 ===")
        try:
            xgb_w, cb_w = learn_ensemble_weights(
                xgb_model_path, model,
                X_cal, positions_cal, groups_cal, feature_names,
            )
            ensemble_weights = {'xgb': xgb_w, 'catboost': cb_w}

            # カテゴリ別重みも学習
            cat_ensemble_weights = {}
            for cat_name in category_metrics:
                cat_mask = sample_categories == cat_name
                cat_cal_idx_list = [i for i in cal_idx if cat_mask[i]]
                if len(cat_cal_idx_list) < 200:
                    cat_ensemble_weights[cat_name] = ensemble_weights.copy()
                    continue

                cat_cal_ordered_e, cat_groups_cal_e = build_race_groups(race_ids, cat_cal_idx_list)

                cat_xgb_model_path = os.path.join(MODEL_DIR, f"xgb_ranker_{cat_name}.json")
                cat_cb_model_path = os.path.join(MODEL_DIR, f"catboost_ranker_{cat_name}.json")

                if os.path.exists(cat_xgb_model_path):
                    # CatBoostカテゴリモデルを再読み込みは不要（メモリ上のモデルを使う）
                    # XGBは使えないので global weights を使用
                    cat_ensemble_weights[cat_name] = ensemble_weights.copy()

            ensemble_weights['per_category'] = cat_ensemble_weights

        except Exception as e:
            print(f"アンサンブル重み学習エラー: {e}")
            print("デフォルト重み (50/50) を使用")

    # アンサンブル重み保存
    with open(os.path.join(MODEL_DIR, "ensemble_weights.json"), 'w', encoding='utf-8') as f:
        json.dump(ensemble_weights, f, ensure_ascii=False, indent=2)
    print(f"アンサンブル重み保存: ensemble_weights.json ({ensemble_weights})")

    # ==================== メタ情報更新 ====================
    meta_path = os.path.join(MODEL_DIR, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        with open(meta_path, 'r', encoding='utf-8') as f:
            meta = json.load(f)

    meta['catboost'] = {
        'global_val_metrics': val_metrics,
        'category_metrics': category_metrics,
        'categories_trained': list(category_metrics.keys()),
        'ensemble_weights': ensemble_weights,
    }

    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # ==================== サマリー ====================
    print(f"\n{'=' * 50}")
    print(f"=== CatBoost 学習完了 ===")
    print(f"{'=' * 50}")
    print(f"グローバル: NDCG@1={val_metrics['ndcg_1']}, Top-1={val_metrics['top1_accuracy']}")
    for cat_name, cm in category_metrics.items():
        print(f"{cat_name}: NDCG@1={cm['ndcg_1']}, Top-1={cm['top1_accuracy']}")
    print(f"アンサンブル重み: {ensemble_weights}")
    print(f"モデル保存先: {MODEL_DIR}")


if __name__ == "__main__":
    main()
