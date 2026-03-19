"""
LightGBM Ranker 学習スクリプト v1.0

XGBoost・CatBoostと並行して LightGBM LambdaRank を学習。
同一データ・同一分割・同一カテゴリ定義を使用。
出力: lgb_ranker.json (TS互換フォーマット)
"""

import json
import math
import os
import sys

import lightgbm as lgb
import numpy as np
from sklearn.metrics import ndcg_score
from sklearn.isotonic import IsotonicRegression

MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "model")
LOCAL_DATA_FILE = os.path.join(MODEL_DIR, "training_data.json")
MIN_SAMPLES = 100
MIN_CATEGORY_SAMPLES = 3000

CATEGORIES = {
    'turf_sprint': (0, 0, 1400),
    'turf_mile': (0, 1401, 1800),
    'turf_long': (0, 1801, 99999),
    'dirt_short': (1, 0, 1600),
    'dirt_long': (1, 1601, 99999),
}


# ==================== ユーティリティ (train_catboost.py と共通) ====================

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


# ==================== LightGBM学習 ====================

def train_lightgbm_ranker(X_train, y_train, groups_train,
                           X_eval, y_eval, groups_eval,
                           sample_weight=None):
    """LightGBM LambdaRank を学習"""
    # sample_weight はグループ単位 → サンプル単位に展開
    train_sample_weights = None
    if sample_weight is not None:
        train_sample_weights = []
        for gi, g in enumerate(groups_train):
            w = float(sample_weight[gi]) if gi < len(sample_weight) else 1.0
            train_sample_weights.extend([w] * int(g))
        train_sample_weights = np.array(train_sample_weights, dtype=np.float32)

    model = lgb.LGBMRanker(
        n_estimators=600,
        max_depth=6,
        learning_rate=0.03,
        num_leaves=63,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_samples=20,
        random_state=42,
        importance_type='gain',
    )

    callbacks = [
        lgb.early_stopping(stopping_rounds=50, verbose=True),
        lgb.log_evaluation(period=100),
    ]

    model.fit(
        X_train, y_train,
        group=groups_train,
        sample_weight=train_sample_weights,
        eval_set=[(X_eval, y_eval)],
        eval_group=[groups_eval],
        eval_at=[1, 3],
        callbacks=callbacks,
    )
    return model


def evaluate_lightgbm(model, X, y_relevance, groups, label=""):
    """LightGBMモデルを評価"""
    y_pred = model.predict(X)

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


def export_lightgbm_for_ts(model, feature_names, filepath):
    """LightGBM モデルを TypeScript 推論互換のJSONフォーマットでエクスポート

    LightGBMのdump_model()からツリー構造を取得し、フラットなJSON形式に変換。
    各ツリーは split_feature, threshold, left_child, right_child, leaf_value を持つ。
    """
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

        def traverse(node, node_index_counter):
            """再帰的にノードを走査してフラット配列を構築する。
            内部ノードは正のインデックス、葉ノードは ~leaf_idx (負値) で参照する。
            戻り値: このノードのインデックス（内部ノードなら>=0、葉ノードなら<0）
            """
            if 'leaf_index' in node:
                # 葉ノード
                leaf_idx = len(leaf_value)
                leaf_value.append(float(node.get('leaf_value', 0.0)))
                return -(leaf_idx + 1)  # ~leaf_idx と同等 (1始まりの負値)
            else:
                # 内部ノード
                node_idx = len(split_feature)
                # プレースホルダーを追加
                split_feature.append(-1)
                threshold.append(0.0)
                decision_type.append('<=')
                left_child.append(0)
                right_child.append(0)

                feat_name = node.get('split_feature', '')
                if feat_name in feature_names:
                    split_feature[node_idx] = feature_names.index(feat_name)
                else:
                    split_feature[node_idx] = 0

                threshold[node_idx] = float(node.get('threshold', 0.0))
                decision_type[node_idx] = node.get('decision_type', '<=')

                left_idx = traverse(node['left_child'], node_index_counter)
                right_idx = traverse(node['right_child'], node_index_counter)

                left_child[node_idx] = left_idx
                right_child[node_idx] = right_idx

                return node_idx

        if tree_structure:
            counter = [0]
            traverse(tree_structure, counter)

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
        'trees': trees,
    }

    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(export_data, f, ensure_ascii=False)

    print(f"LightGBM TS互換モデル保存: {filepath} ({len(trees)} trees)")
    return export_data


def fit_lightgbm_calibration(model, X_cal, positions_cal, groups_cal):
    """LightGBM用 Isotonic Regression 較正"""
    raw_scores = model.predict(X_cal)

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
    print(f"  LightGBM Brier: {brier_before:.6f} → {brier_after:.6f} ({improvement:+.1f}%)")
    print(f"  LightGBM ECE:   {ece_before:.4f} → {ece_after:.4f}")

    return ir


# ==================== アンサンブル重み学習 (3モデル) ====================

def learn_ensemble_weights_3way(xgb_scores, cb_scores, lgb_scores,
                                 positions_cal, groups_cal):
    """XGBoost + CatBoost + LightGBMの3Way最適ブレンド重みをグリッドサーチで探索"""
    y_relevance = np.array(
        [position_to_relevance(int(p)) for p in positions_cal]
    )
    y_true_groups = split_by_groups(y_relevance, groups_cal)

    best_weights = (0.34, 0.33, 0.33)
    best_ndcg = 0.0

    step = 0.05
    candidates = np.arange(0.0, 1.0 + step, step)

    for w_xgb in candidates:
        for w_cb in candidates:
            w_lgb = round(1.0 - w_xgb - w_cb, 10)
            if w_lgb < -1e-9 or w_lgb > 1.0 + 1e-9:
                continue
            w_lgb = max(0.0, min(1.0, w_lgb))

            blended = w_xgb * xgb_scores + w_cb * cb_scores + w_lgb * lgb_scores
            y_pred_groups = split_by_groups(blended, groups_cal)
            ndcg = calc_ndcg_at_k(y_true_groups, y_pred_groups, k=1)

            if ndcg > best_ndcg:
                best_ndcg = ndcg
                best_weights = (round(w_xgb, 2), round(w_cb, 2), round(w_lgb, 2))

    w_xgb, w_cb, w_lgb = best_weights
    print(f"\n3Wayアンサンブル最適重み: XGBoost={w_xgb}, CatBoost={w_cb}, LightGBM={w_lgb}")
    print(f"最適NDCG@1: {best_ndcg:.4f}")

    return w_xgb, w_cb, w_lgb


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
    recency_data = np.array([r.get("recency_weight", 1.0) for r in rows], dtype=np.float32)
    has_odds = int(np.sum(odds_data > 0)) > len(odds_data) // 2

    # 時系列分割 (XGBoost・CatBoostと完全同一)
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
        # オッズ重みと近接性重みを乗算（コンセプトドリフト対応）
        recency_group_weights = []
        offset = 0
        for g in groups_train:
            g = int(g)
            group_recency = recency_data[train_ordered[offset:offset + g]]
            recency_group_weights.append(float(np.mean(group_recency)))
            offset += g
        recency_group_weights = np.array(recency_group_weights, dtype=np.float32)
        train_weights = train_weights * recency_group_weights
        print("オッズ加重 × 近接性重み有効")

    # ==================== グローバルモデル ====================
    print("\n=== LightGBM グローバルモデル学習 ===")
    model = train_lightgbm_ranker(
        X_train, y_train, groups_train,
        X_cal, y_cal, groups_cal,
        sample_weight=train_weights,
    )

    print("\n--- 検証セット ---")
    val_metrics = evaluate_lightgbm(model, X_cal, y_cal, groups_cal, "LightGBM-Val")

    print("\n--- テストセット ---")
    test_metrics = evaluate_lightgbm(model, X_test, y_test, groups_test, "LightGBM-Test")

    # 較正
    print("\n=== LightGBM Isotonic Regression 較正 ===")
    ir = fit_lightgbm_calibration(model, X_cal, positions_cal, groups_cal)

    # TS互換フォーマットで保存
    export_lightgbm_for_ts(
        model, feature_names,
        os.path.join(MODEL_DIR, "lgb_ranker.json"),
    )

    # 較正保存
    cal_data = {
        'x_thresholds': ir.X_thresholds_.tolist(),
        'y_values': ir.y_thresholds_.tolist(),
    }
    with open(os.path.join(MODEL_DIR, "lgb_calibration.json"), 'w', encoding='utf-8') as f:
        json.dump(cal_data, f, ensure_ascii=False, indent=2)
    print(f"LightGBM較正保存: lgb_calibration.json")

    # ==================== カテゴリ別モデル ====================
    print("\n=== LightGBM カテゴリ別モデル ===")

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
            # カテゴリモデルにも近接性重みを適用
            cat_recency_group_weights = []
            offset = 0
            for g in cat_groups_train:
                g = int(g)
                group_recency = recency_data[cat_train_ordered[offset:offset + g]]
                cat_recency_group_weights.append(float(np.mean(group_recency)))
                offset += g
            cat_recency_group_weights = np.array(cat_recency_group_weights, dtype=np.float32)
            cat_train_weights = cat_train_weights * cat_recency_group_weights

        cat_model = train_lightgbm_ranker(
            X[cat_train_ordered], y_standard[cat_train_ordered], cat_groups_train,
            X[cat_cal_ordered], y_standard[cat_cal_ordered], cat_groups_cal,
            sample_weight=cat_train_weights,
        )

        cat_val = evaluate_lightgbm(
            cat_model, X[cat_cal_ordered], y_standard[cat_cal_ordered],
            cat_groups_cal, cat_name,
        )

        cat_filename = f"lgb_ranker_{cat_name}.json"
        export_lightgbm_for_ts(
            cat_model, feature_names,
            os.path.join(MODEL_DIR, cat_filename),
        )

        category_metrics[cat_name] = cat_val

    # ==================== アンサンブル重み (3Way) ====================
    xgb_model_path = os.path.join(MODEL_DIR, "xgb_ranker.json")
    cb_model_path = os.path.join(MODEL_DIR, "catboost_ranker.json")
    ensemble_weights = {'xgb': 0.34, 'catboost': 0.33, 'lightgbm': 0.33}

    if os.path.exists(xgb_model_path) and os.path.exists(cb_model_path):
        print("\n=== 3Wayアンサンブル重み学習 ===")
        try:
            import xgboost as xgb
            from catboost import CatBoostRanker, Pool

            xgb_model = xgb.XGBRanker()
            xgb_model.load_model(xgb_model_path)
            xgb_scores = xgb_model.predict(X_cal)

            # CatBoost: query_id配列を生成
            query_ids = []
            for gi, g in enumerate(groups_cal):
                query_ids.extend([gi] * int(g))
            query_ids = np.array(query_ids, dtype=np.int32)
            pool = Pool(data=X_cal, group_id=query_ids)

            cb_model = CatBoostRanker()
            cb_model.load_model(cb_model_path)
            cb_scores = cb_model.predict(pool)

            lgb_scores = model.predict(X_cal)

            w_xgb, w_cb, w_lgb = learn_ensemble_weights_3way(
                xgb_scores, cb_scores, lgb_scores,
                positions_cal, groups_cal,
            )
            ensemble_weights = {
                'xgb': w_xgb,
                'catboost': w_cb,
                'lightgbm': w_lgb,
            }

            # 既存の ensemble_weights.json を読み込んで per_category を保持
            ensemble_weights_path = os.path.join(MODEL_DIR, "ensemble_weights.json")
            existing_weights = {}
            if os.path.exists(ensemble_weights_path):
                with open(ensemble_weights_path, 'r', encoding='utf-8') as f:
                    existing_weights = json.load(f)

            per_category = existing_weights.get('per_category', {})
            ensemble_weights['per_category'] = per_category

        except Exception as e:
            print(f"3Wayアンサンブル重み学習エラー: {e}")
            print("デフォルト重み (34/33/33) を使用")
    else:
        print("\nXGBoostまたはCatBoostモデルが見つかりません → デフォルト重みを使用")

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

    meta['lightgbm'] = {
        'global_val_metrics': val_metrics,
        'global_test_metrics': test_metrics,
        'category_metrics': category_metrics,
        'categories_trained': list(category_metrics.keys()),
        'ensemble_weights': ensemble_weights,
    }

    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # ==================== サマリー ====================
    print(f"\n{'=' * 50}")
    print(f"=== LightGBM 学習完了 ===")
    print(f"{'=' * 50}")
    print(f"グローバル: NDCG@1={val_metrics['ndcg_1']}, Top-1={val_metrics['top1_accuracy']}")
    for cat_name, cm in category_metrics.items():
        print(f"{cat_name}: NDCG@1={cm['ndcg_1']}, Top-1={cm['top1_accuracy']}")
    print(f"アンサンブル重み: {ensemble_weights}")
    print(f"モデル保存先: {MODEL_DIR}")


if __name__ == "__main__":
    main()
