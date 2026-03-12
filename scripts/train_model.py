"""
XGBoost モデル自動学習スクリプト v6.0

v6.0 Phase 2:
- 70/15/15 train/calibration/test 時系列分割
- Isotonic Regression 確率較正 (Platt Scaling)
- オッズ加重 NDCG gain (ROI最適化)
- カテゴリ別専門モデル (5カテゴリ)

GitHub Actions / ローカル両対応。
"""

import json
import math
import os
import sys

import numpy as np
import requests
import xgboost as xgb
from sklearn.metrics import ndcg_score
from sklearn.isotonic import IsotonicRegression

# ==================== 設定 ====================

VERCEL_URL = os.environ.get("VERCEL_URL", "").rstrip("/")
SYNC_KEY = os.environ.get("SYNC_KEY", "")
MIN_SAMPLES = 100
MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "model")
LOCAL_DATA_FILE = os.path.join(MODEL_DIR, "training_data.json")
MIN_CATEGORY_SAMPLES = 3000

# カテゴリ定義: (trackType_encoded, distance_min, distance_max)
CATEGORIES = {
    'turf_sprint': (0, 0, 1400),
    'turf_mile': (0, 1401, 1800),
    'turf_long': (0, 1901, 99999),
    'dirt_short': (1, 0, 1600),
    'dirt_long': (1, 1601, 99999),
}


# ==================== ユーティリティ ====================

def categorize_race(track_type_encoded, distance):
    """レースをカテゴリに分類"""
    for cat, (tt, d_min, d_max) in CATEGORIES.items():
        if int(track_type_encoded) == tt and d_min <= distance <= d_max:
            return cat
    return None


def position_to_relevance(position):
    """着順をグレーデッドリレバンスに変換"""
    if position == 1:
        return 3
    elif position == 2:
        return 2
    elif position == 3:
        return 1
    else:
        return 0


def compute_race_weights(positions, odds_data, ordered_indices, groups):
    """レース単位のオッズ加重: 高配当勝者のレースを重視 (1 weight per group)"""
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


def softmax_np(scores):
    """NumPy softmax (数値安定化版)"""
    max_s = np.max(scores)
    exps = np.exp(scores - max_s)
    return exps / np.sum(exps)


def build_race_groups(race_ids, indices):
    """race_id でソートし、各レースの馬数をgroup配列として構築"""
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
    """グループサイズ配列に従ってyをグループに分割"""
    result = []
    offset = 0
    for g in groups:
        result.append(y[offset:offset + int(g)].tolist())
        offset += int(g)
    return result


def calc_ndcg_at_k(y_true_groups, y_pred_groups, k):
    """グループごとのNDCG@kを計算"""
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
    """グループごとのTop-k精度を計算"""
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


def compute_ece(probs, actuals, n_bins=10):
    """Expected Calibration Error"""
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


# ==================== データ取得 ====================

def fetch_chunk(url, headers, retries=2):
    """1チャンクを取得（リトライ付き）"""
    for attempt in range(retries + 1):
        try:
            resp = requests.get(url, headers=headers, timeout=55)
            resp.raise_for_status()
            return resp.json()
        except (requests.exceptions.Timeout, requests.exceptions.HTTPError) as e:
            if attempt < retries:
                wait = 2 ** (attempt + 1)
                print(f"  リトライ ({attempt + 1}/{retries}): {wait}秒待機...")
                import time
                time.sleep(wait)
            else:
                raise


def fetch_data():
    """Vercel API から四半期単位で分割取得"""
    headers = {}
    if SYNC_KEY:
        headers["x-sync-key"] = SYNC_KEY

    from datetime import date

    current_year = date.today().year
    all_rows = []
    feature_names = None

    quarters = [(1, 3), (4, 6), (7, 9), (10, 12)]

    for year in range(2020, current_year + 1):
        for q_start, q_end in quarters:
            from_date = f"{year}-{q_start:02d}-01"
            if q_end == 12:
                to_date = f"{year}-12-31"
            else:
                next_month = q_end + 1
                from datetime import timedelta
                to_dt = date(year, next_month, 1) - timedelta(days=1)
                to_date = to_dt.isoformat()

            if date(year, q_start, 1) > date.today():
                break

            url = f"{VERCEL_URL}/api/ml-export?from={from_date}&to={to_date}"
            print(f"データ取得中: {url}")
            chunk = fetch_chunk(url, headers)

            if feature_names is None and chunk.get("feature_names"):
                feature_names = chunk["feature_names"]

            rows = chunk.get("rows", [])
            print(f"  {year}Q{quarters.index((q_start, q_end)) + 1}: {len(rows)}件")
            all_rows.extend(rows)

    if feature_names is None:
        print("ERROR: 特徴量名が取得できませんでした")
        sys.exit(1)

    return {"feature_names": feature_names, "rows": all_rows}


def load_local_data():
    """ローカルの training_data.json から読み込む"""
    print(f"ローカルデータ読み込み: {LOCAL_DATA_FILE}")
    with open(LOCAL_DATA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


# ==================== モデル学習 ====================

def train_ranker_model(X_train, y_train, groups_train, X_eval, y_eval, groups_eval,
                       sample_weight=None):
    """XGBRanker (LambdaMART) を学習"""
    model = xgb.XGBRanker(
        n_estimators=400,
        max_depth=5,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        eval_metric="ndcg",
        early_stopping_rounds=30,
        random_state=42,
        objective="rank:ndcg",
    )

    fit_kwargs = dict(
        group=groups_train,
        eval_set=[(X_eval, y_eval)],
        eval_group=[groups_eval],
        verbose=50,
    )
    if sample_weight is not None:
        fit_kwargs["sample_weight"] = sample_weight

    model.fit(X_train, y_train, **fit_kwargs)

    return model


def evaluate_ranker(model, X, y_relevance, groups, label=""):
    """ランカーモデルを標準リレバンスで評価"""
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


# ==================== Platt Scaling ====================

def fit_calibration(model, X_cal, positions_cal, groups_cal):
    """Isotonic Regression で確率較正モデルを学習"""
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
    print(f"  Brier: {brier_before:.6f} → {brier_after:.6f} ({improvement:+.1f}%)")
    print(f"  ECE:   {ece_before:.4f} → {ece_after:.4f}")

    return ir


def evaluate_calibrated(model, ir, X_test, positions_test, groups_test):
    """テストセットで較正済みモデルを評価"""
    raw_scores = model.predict(X_test)

    all_probs_raw = []
    all_probs_cal = []
    actual_wins = []
    y_true_groups = []
    y_pred_groups = []

    offset = 0
    for g in groups_test:
        g = int(g)
        group_raw = raw_scores[offset:offset + g]
        group_pos = positions_test[offset:offset + g]

        probs_raw = softmax_np(group_raw)
        probs_cal = ir.predict(probs_raw)
        cal_sum = np.sum(probs_cal)
        if cal_sum > 0:
            probs_cal = probs_cal / cal_sum

        for i in range(g):
            all_probs_raw.append(float(probs_raw[i]))
            all_probs_cal.append(float(probs_cal[i]))
            actual_wins.append(1 if int(group_pos[i]) == 1 else 0)

        y_true_groups.append([position_to_relevance(int(p)) for p in group_pos])
        y_pred_groups.append(group_raw.tolist())
        offset += g

    all_probs_raw = np.array(all_probs_raw)
    all_probs_cal = np.array(all_probs_cal)
    actual_wins = np.array(actual_wins)

    brier_raw = float(np.mean((all_probs_raw - actual_wins) ** 2))
    brier_cal = float(np.mean((all_probs_cal - actual_wins) ** 2))
    ece_raw = compute_ece(all_probs_raw, actual_wins)
    ece_cal = compute_ece(all_probs_cal, actual_wins)

    ndcg_1 = calc_ndcg_at_k(y_true_groups, y_pred_groups, k=1)
    ndcg_3 = calc_ndcg_at_k(y_true_groups, y_pred_groups, k=3)
    top1 = calc_top_k_accuracy(y_true_groups, y_pred_groups, k=1)
    top3 = calc_top_k_accuracy(y_true_groups, y_pred_groups, k=3)

    print(f"\n=== テストセット最終評価 ===")
    print(f"Brier: {brier_raw:.6f} → {brier_cal:.6f}")
    print(f"ECE:   {ece_raw:.4f} → {ece_cal:.4f}")
    print(f"NDCG@1: {ndcg_1:.4f}, NDCG@3: {ndcg_3:.4f}")
    print(f"Top-1: {top1:.4f}, Top-3: {top3:.4f}")

    return {
        'brier_raw': round(brier_raw, 6),
        'brier_calibrated': round(brier_cal, 6),
        'ece_raw': round(ece_raw, 4),
        'ece_calibrated': round(ece_cal, 4),
        'ndcg_1': round(ndcg_1, 4),
        'ndcg_3': round(ndcg_3, 4),
        'top1_accuracy': round(top1, 4),
        'top3_accuracy': round(top3, 4),
    }


def save_calibration(ir, filepath):
    """較正マッピングをJSONで保存"""
    calibration = {
        'x_thresholds': ir.X_thresholds_.tolist(),
        'y_values': ir.y_thresholds_.tolist(),
    }
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(calibration, f, ensure_ascii=False, indent=2)
    print(f"較正マッピング保存: {filepath} ({len(ir.X_thresholds_)} points)")


# ==================== メイン ====================

def main():
    # データ読み込み
    if os.path.exists(LOCAL_DATA_FILE):
        data = load_local_data()
    elif VERCEL_URL:
        data = fetch_data()
    else:
        print("ERROR: ローカルデータ (model/training_data.json) も VERCEL_URL も見つかりません")
        sys.exit(1)

    feature_names = data["feature_names"]
    rows = data["rows"]

    print(f"総サンプル数: {len(rows)}")
    print(f"特徴量数: {len(feature_names)}")

    if len(rows) < MIN_SAMPLES:
        print(f"サンプル数が{MIN_SAMPLES}件未満のため学習スキップ ({len(rows)}件)")
        sys.exit(0)

    has_position = all("position" in r for r in rows[:100])
    if not has_position:
        print("ERROR: positionフィールドが必要です (v6.0)")
        sys.exit(1)

    # NumPy配列に変換
    X = np.array([r["features"] for r in rows], dtype=np.float32)
    race_ids = [r["race_id"] for r in rows]
    positions = np.array([r["position"] for r in rows], dtype=np.int32)
    odds_data = np.array([r.get("odds") or 0 for r in rows], dtype=np.float32)

    has_odds = int(np.sum(odds_data > 0)) > len(odds_data) // 2
    print(f"オッズデータ: {'あり' if has_odds else 'なし'} ({int(np.sum(odds_data > 0))}/{len(odds_data)}件)")

    # 時系列分割: 70/15/15
    sorted_indices = sorted(range(len(rows)), key=lambda i: race_ids[i])
    split_train = int(len(sorted_indices) * 0.70)
    split_cal = int(len(sorted_indices) * 0.85)
    train_idx = sorted_indices[:split_train]
    cal_idx = sorted_indices[split_train:split_cal]
    test_idx = sorted_indices[split_cal:]

    print(f"学習: {len(train_idx)}件, 較正: {len(cal_idx)}件, テスト: {len(test_idx)}件")

    os.makedirs(MODEL_DIR, exist_ok=True)

    # グレーデッドリレバンス (標準integer labels: 0-3)
    y_standard = np.array(
        [position_to_relevance(p) for p in positions], dtype=np.float32
    )

    # レースグループ構築 (3分割)
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

    # オッズ加重 sample_weight (レース単位)
    train_weights = None
    if has_odds:
        train_weights = compute_race_weights(positions, odds_data, train_ordered, groups_train)
        print("オッズ加重 sample_weight 有効")
    else:
        print("オッズデータ不足のため均等重み使用")

    # ==================== グローバルモデル ====================
    print("\n=== グローバルモデル学習 (オッズ加重NDCG) ===")
    model = train_ranker_model(
        X_train, y_train, groups_train,
        X_cal, y_cal, groups_cal,
        sample_weight=train_weights,
    )

    # 標準リレバンスでの評価
    print("\n--- 検証セット (標準NDCG) ---")
    val_metrics = evaluate_ranker(model, X_cal, y_cal, groups_cal, "Global-Val")

    # Platt Scaling
    print("\n=== Platt Scaling (Isotonic Regression) ===")
    ir = fit_calibration(model, X_cal, positions_cal, groups_cal)

    # テストセット評価
    test_metrics = evaluate_calibrated(model, ir, X_test, positions_test, groups_test)

    # グローバルモデル保存
    model.save_model(os.path.join(MODEL_DIR, "xgb_ranker.json"))
    save_calibration(ir, os.path.join(MODEL_DIR, "calibration.json"))

    with open(os.path.join(MODEL_DIR, "feature_names.json"), "w", encoding="utf-8") as f:
        json.dump(feature_names, f, ensure_ascii=False, indent=2)

    # ==================== カテゴリ別モデル ====================
    print("\n=== カテゴリ別モデル学習 ===")

    # カテゴリ判定: メタデータ優先、なければ特徴量から
    if 'track_type_encoded' in rows[0]:
        sample_categories = np.array([
            categorize_race(r['track_type_encoded'], r['distance_val'])
            for r in rows
        ], dtype=object)
        print("カテゴリ判定: メタデータ使用")
    else:
        track_type_idx = feature_names.index('trackType_encoded')
        distance_idx = feature_names.index('distance')
        sample_categories = np.array([
            categorize_race(X[i, track_type_idx], X[i, distance_idx])
            for i in range(len(rows))
        ], dtype=object)
        print("カテゴリ判定: 特徴量使用")

    category_metrics = {}

    for cat_name in CATEGORIES:
        cat_mask = sample_categories == cat_name
        cat_train_idx = [i for i in train_idx if cat_mask[i]]
        cat_cal_idx = [i for i in cal_idx if cat_mask[i]]

        print(f"\n--- {cat_name}: 学習{len(cat_train_idx)}件, 較正{len(cat_cal_idx)}件 ---")

        if len(cat_train_idx) < MIN_CATEGORY_SAMPLES:
            print(f"  サンプル不足 (< {MIN_CATEGORY_SAMPLES}) → スキップ")
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

        cat_model = train_ranker_model(
            X[cat_train_ordered], y_standard[cat_train_ordered], cat_groups_train,
            X[cat_cal_ordered], y_standard[cat_cal_ordered], cat_groups_cal,
            sample_weight=cat_train_weights,
        )

        cat_val = evaluate_ranker(
            cat_model, X[cat_cal_ordered], y_standard[cat_cal_ordered],
            cat_groups_cal, cat_name
        )

        cat_filename = f"xgb_ranker_{cat_name}.json"
        cat_model.save_model(os.path.join(MODEL_DIR, cat_filename))
        print(f"  保存: {cat_filename}")

        category_metrics[cat_name] = cat_val

    # ==================== メタ情報保存 ====================
    meta = {
        "model_type": "ranker_v6",
        "train_samples": len(train_idx),
        "cal_samples": len(cal_idx),
        "test_samples": len(test_idx),
        "feature_count": len(feature_names),
        "calibration": "isotonic_regression",
        "odds_weighted_gain": has_odds,
        "global_val_metrics": val_metrics,
        "global_test_metrics": test_metrics,
        "category_metrics": category_metrics,
        "categories_trained": list(category_metrics.keys()),
    }
    with open(os.path.join(MODEL_DIR, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # ==================== サマリー ====================
    print(f"\n{'=' * 50}")
    print(f"=== 学習完了 (v6.0 Phase 2) ===")
    print(f"{'=' * 50}")
    print(f"グローバル: NDCG@1={val_metrics['ndcg_1']}, Top-1={val_metrics['top1_accuracy']}")
    print(f"較正: Brier {test_metrics['brier_raw']:.6f} → {test_metrics['brier_calibrated']:.6f}")
    print(f"ECE: {test_metrics['ece_raw']:.4f} → {test_metrics['ece_calibrated']:.4f}")
    for cat_name, cm in category_metrics.items():
        print(f"{cat_name}: NDCG@1={cm['ndcg_1']}, Top-1={cm['top1_accuracy']}")
    print(f"モデル保存先: {MODEL_DIR}")


if __name__ == "__main__":
    main()
