"""
XGBoost 複勝予測専用モデル学習スクリプト v1.0

特徴:
- XGBClassifier (binary:logistic) でTop-3フィニッシュを二値分類
- 70/15/15 時系列分割 (train/calibration/test)
- Isotonic Regression 確率較正
- レース内正規化: 各レースの予測確率合計を~3.0にスケール
- カテゴリ別専門モデル (5カテゴリ)

出力:
- model/xgb_place_classifier.json (グローバルモデル)
- model/place_calibration.json (較正マッピング)
- model/xgb_place_{category}.json (カテゴリ別モデル)
- model/place_meta.json (メタ情報)
"""

import json
import math
import os
import sys
import time

import numpy as np
import requests
import xgboost as xgb
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import (
    roc_auc_score,
    brier_score_loss,
    precision_score,
    recall_score,
)

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
    'turf_long': (0, 1801, 99999),
    'dirt_short': (1, 0, 1600),
    'dirt_long': (1, 1601, 99999),
}

# XGBClassifier ハイパーパラメータ
CLASSIFIER_PARAMS = dict(
    n_estimators=600,
    max_depth=5,
    learning_rate=0.03,
    subsample=0.8,
    colsample_bytree=0.8,
    eval_metric="logloss",
    early_stopping_rounds=30,
    random_state=42,
    objective="binary:logistic",
    use_label_encoder=False,
)

# 複勝判定閾値 (Top-3に入れば正例)
PLACE_THRESHOLD = 3

# precision/recall 計算時の確率閾値
EVAL_PROB_THRESHOLD = 0.3


# ==================== ユーティリティ ====================

def categorize_race(track_type_encoded, distance):
    """レースをカテゴリに分類"""
    for cat, (tt, d_min, d_max) in CATEGORIES.items():
        if int(track_type_encoded) == tt and d_min <= distance <= d_max:
            return cat
    return None


def position_to_place_label(position):
    """着順を複勝ラベルに変換 (Top-3=1, それ以外=0)"""
    return 1 if int(position) <= PLACE_THRESHOLD else 0


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


def normalize_race_probs(probs, race_ids_ordered, target_sum=3.0):
    """
    レース内正規化: 各レースの予測確率合計を target_sum (~3.0) にスケール。
    複勝は1レースにつき約3頭が的中するため、合計確率を3.0に正規化する。
    """
    result = probs.copy()
    unique_races = []
    seen = set()
    for rid in race_ids_ordered:
        if rid not in seen:
            unique_races.append(rid)
            seen.add(rid)

    race_id_to_indices = {}
    for idx, rid in enumerate(race_ids_ordered):
        race_id_to_indices.setdefault(rid, []).append(idx)

    for rid in unique_races:
        indices = race_id_to_indices[rid]
        race_probs = result[indices]
        prob_sum = np.sum(race_probs)
        if prob_sum > 0:
            result[indices] = race_probs * (target_sum / prob_sum)

    return result


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
                time.sleep(wait)
            else:
                raise


def fetch_data():
    """Vercel API から四半期単位で分割取得"""
    headers = {}
    if SYNC_KEY:
        headers["x-sync-key"] = SYNC_KEY

    from datetime import date, timedelta

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

def train_classifier(X_train, y_train, X_eval, y_eval,
                     scale_pos_weight=1.0, sample_weight=None):
    """XGBClassifier (binary:logistic) を学習"""
    params = {**CLASSIFIER_PARAMS, "scale_pos_weight": scale_pos_weight}
    model = xgb.XGBClassifier(**params)

    fit_kwargs = dict(
        eval_set=[(X_eval, y_eval)],
        verbose=50,
    )
    if sample_weight is not None:
        fit_kwargs["sample_weight"] = sample_weight

    model.fit(X_train, y_train, **fit_kwargs)
    return model


def compute_scale_pos_weight(y_labels):
    """正例/負例比率から scale_pos_weight を計算"""
    n_pos = int(np.sum(y_labels == 1))
    n_neg = int(np.sum(y_labels == 0))
    if n_pos == 0:
        return 1.0
    return n_neg / n_pos


def compute_sample_weights(positions, recency_data, indices):
    """近接性重みを sample_weight として適用 (サンプル単位)"""
    return recency_data[indices].copy()


# ==================== 評価 ====================

def evaluate_classifier(model, X, y_labels, race_ids_ordered, label="",
                        ir=None, prob_threshold=EVAL_PROB_THRESHOLD):
    """
    分類器を評価:
    - AUC-ROC
    - Brier Score
    - Precision / Recall @ prob_threshold
    - レース内正規化後のTop-3精度
    """
    raw_probs = model.predict_proba(X)[:, 1]

    # Isotonic Regression 較正
    if ir is not None:
        cal_probs = ir.predict(raw_probs)
    else:
        cal_probs = raw_probs

    # AUC-ROC (較正後)
    try:
        auc = roc_auc_score(y_labels, cal_probs)
    except ValueError:
        auc = float("nan")

    # Brier Score
    brier = brier_score_loss(y_labels, cal_probs)

    # Precision / Recall @ threshold
    binary_pred = (cal_probs >= prob_threshold).astype(int)
    precision = precision_score(y_labels, binary_pred, zero_division=0)
    recall = recall_score(y_labels, binary_pred, zero_division=0)

    # レース内正規化後のTop-3精度
    normalized_probs = normalize_race_probs(cal_probs, race_ids_ordered)
    top3_correct = 0
    top3_total = 0

    race_id_to_indices = {}
    for idx, rid in enumerate(race_ids_ordered):
        race_id_to_indices.setdefault(rid, []).append(idx)

    for rid, indices in race_id_to_indices.items():
        if len(indices) < 4:
            continue
        top3_total += 1
        race_labels = y_labels[indices]
        race_norm_probs = normalized_probs[indices]
        # 確率上位3つを予測Top-3として判定
        top3_pred_indices = np.argsort(race_norm_probs)[-3:]
        actual_top3_indices = set(np.where(race_labels == 1)[0])
        if len(actual_top3_indices & set(top3_pred_indices)) > 0:
            top3_correct += 1

    top3_acc = top3_correct / top3_total if top3_total > 0 else 0.0

    prefix = f"[{label}] " if label else ""
    print(
        f"{prefix}AUC-ROC: {auc:.4f}, Brier: {brier:.6f}, "
        f"Precision@{prob_threshold}: {precision:.4f}, Recall@{prob_threshold}: {recall:.4f}, "
        f"Top3-Acc: {top3_acc:.4f}"
    )

    return {
        "auc_roc": round(float(auc), 4),
        "brier_score": round(float(brier), 6),
        f"precision_at_{prob_threshold}": round(float(precision), 4),
        f"recall_at_{prob_threshold}": round(float(recall), 4),
        "top3_accuracy": round(float(top3_acc), 4),
        "races_evaluated": top3_total,
    }


# ==================== Isotonic Regression 較正 ====================

def fit_calibration(model, X_cal, y_labels_cal):
    """Isotonic Regression で確率較正モデルを学習"""
    raw_probs = model.predict_proba(X_cal)[:, 1]

    ir = IsotonicRegression(out_of_bounds='clip')
    ir.fit(raw_probs, y_labels_cal)

    cal_probs = ir.predict(raw_probs)
    brier_before = float(np.mean((raw_probs - y_labels_cal) ** 2))
    brier_after = float(np.mean((cal_probs - y_labels_cal) ** 2))
    ece_before = compute_ece(raw_probs, y_labels_cal.astype(float))
    ece_after = compute_ece(cal_probs, y_labels_cal.astype(float))

    improvement = (1 - brier_after / brier_before) * 100 if brier_before > 0 else 0
    print(f"  Brier: {brier_before:.6f} → {brier_after:.6f} ({improvement:+.1f}%)")
    print(f"  ECE:   {ece_before:.4f} → {ece_after:.4f}")

    return ir


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
        print("ERROR: positionフィールドが必要です")
        sys.exit(1)

    # NumPy配列に変換
    X = np.array([r["features"] for r in rows], dtype=np.float32)
    race_ids = [r["race_id"] for r in rows]
    positions = np.array([r["position"] for r in rows], dtype=np.int32)
    recency_data = np.array([r.get("recency_weight", 1.0) for r in rows], dtype=np.float32)

    # 複勝ラベル生成 (Top-3=1, それ以外=0)
    y_place = np.array([position_to_place_label(p) for p in positions], dtype=np.int32)
    n_pos = int(np.sum(y_place == 1))
    n_neg = int(np.sum(y_place == 0))
    print(f"複勝ラベル: 正例(Top-3)={n_pos}件, 負例={n_neg}件, 比率={n_neg/n_pos:.2f}:1")

    # 時系列分割: 70/15/15
    sorted_indices = sorted(range(len(rows)), key=lambda i: race_ids[i])
    split_train = int(len(sorted_indices) * 0.70)
    split_cal = int(len(sorted_indices) * 0.85)
    train_idx = sorted_indices[:split_train]
    cal_idx = sorted_indices[split_train:split_cal]
    test_idx = sorted_indices[split_cal:]

    print(f"学習: {len(train_idx)}件, 較正: {len(cal_idx)}件, テスト: {len(test_idx)}件")

    os.makedirs(MODEL_DIR, exist_ok=True)

    # インデックスをNumPy配列に変換
    train_idx_arr = np.array(train_idx, dtype=np.int64)
    cal_idx_arr = np.array(cal_idx, dtype=np.int64)
    test_idx_arr = np.array(test_idx, dtype=np.int64)

    X_train = X[train_idx_arr]
    X_cal = X[cal_idx_arr]
    X_test = X[test_idx_arr]

    y_train = y_place[train_idx_arr]
    y_cal = y_place[cal_idx_arr]
    y_test = y_place[test_idx_arr]

    race_ids_train = [race_ids[i] for i in train_idx_arr]
    race_ids_cal = [race_ids[i] for i in cal_idx_arr]
    race_ids_test = [race_ids[i] for i in test_idx_arr]

    # scale_pos_weight を学習セットの比率から計算
    global_spw = compute_scale_pos_weight(y_train)
    print(f"scale_pos_weight: {global_spw:.2f}")

    # 近接性重み (サンプル単位)
    train_weights = compute_sample_weights(positions, recency_data, train_idx_arr)
    print("近接性重み sample_weight 有効")

    # ==================== グローバルモデル ====================
    print("\n=== グローバルモデル学習 (XGBClassifier) ===")
    model = train_classifier(
        X_train, y_train,
        X_cal, y_cal,
        scale_pos_weight=global_spw,
        sample_weight=train_weights,
    )

    # Isotonic Regression 較正
    print("\n=== Platt Scaling (Isotonic Regression) ===")
    ir = fit_calibration(model, X_cal, y_cal)

    # 検証セット評価
    print("\n--- 検証セット評価 ---")
    val_metrics = evaluate_classifier(
        model, X_cal, y_cal, race_ids_cal, "Global-Val", ir=ir
    )

    # テストセット評価
    print("\n--- テストセット最終評価 ---")
    test_metrics = evaluate_classifier(
        model, X_test, y_test, race_ids_test, "Global-Test", ir=ir
    )

    # グローバルモデル保存
    global_model_path = os.path.join(MODEL_DIR, "xgb_place_classifier.json")
    model.save_model(global_model_path)
    print(f"グローバルモデル保存: {global_model_path}")

    cal_path = os.path.join(MODEL_DIR, "place_calibration.json")
    save_calibration(ir, cal_path)

    with open(os.path.join(MODEL_DIR, "feature_names.json"), "w", encoding="utf-8") as f:
        json.dump(feature_names, f, ensure_ascii=False, indent=2)

    # ==================== カテゴリ別モデル ====================
    print("\n=== カテゴリ別モデル学習 ===")

    track_type_idx = feature_names.index('trackType_encoded')
    distance_idx = feature_names.index('distance')

    # 各サンプルのカテゴリを判定
    sample_categories = np.array([
        categorize_race(X[i, track_type_idx], X[i, distance_idx])
        for i in range(len(rows))
    ], dtype=object)

    category_metrics = {}

    for cat_name in CATEGORIES:
        cat_mask = sample_categories == cat_name
        cat_train_idx = [i for i in train_idx if cat_mask[i]]
        cat_cal_idx = [i for i in cal_idx if cat_mask[i]]
        cat_test_idx = [i for i in test_idx if cat_mask[i]]

        print(
            f"\n--- {cat_name}: 学習{len(cat_train_idx)}件, "
            f"較正{len(cat_cal_idx)}件, テスト{len(cat_test_idx)}件 ---"
        )

        if len(cat_train_idx) < MIN_CATEGORY_SAMPLES:
            print(f"  サンプル不足 (< {MIN_CATEGORY_SAMPLES}) → スキップ")
            continue

        if len(cat_cal_idx) < 50:
            print(f"  較正サンプル不足 → スキップ")
            continue

        cat_train_idx_arr = np.array(cat_train_idx, dtype=np.int64)
        cat_cal_idx_arr = np.array(cat_cal_idx, dtype=np.int64)
        cat_test_idx_arr = np.array(cat_test_idx, dtype=np.int64)

        X_cat_train = X[cat_train_idx_arr]
        X_cat_cal = X[cat_cal_idx_arr]
        X_cat_test = X[cat_test_idx_arr]

        y_cat_train = y_place[cat_train_idx_arr]
        y_cat_cal = y_place[cat_cal_idx_arr]
        y_cat_test = y_place[cat_test_idx_arr]

        cat_race_ids_cal = [race_ids[i] for i in cat_cal_idx_arr]
        cat_race_ids_test = [race_ids[i] for i in cat_test_idx_arr]

        cat_spw = compute_scale_pos_weight(y_cat_train)
        print(f"  scale_pos_weight: {cat_spw:.2f}")

        cat_weights = compute_sample_weights(positions, recency_data, cat_train_idx_arr)

        cat_model = train_classifier(
            X_cat_train, y_cat_train,
            X_cat_cal, y_cat_cal,
            scale_pos_weight=cat_spw,
            sample_weight=cat_weights,
        )

        # カテゴリ別較正
        cat_ir = fit_calibration(cat_model, X_cat_cal, y_cat_cal)

        # カテゴリ別評価 (較正後)
        cat_val = evaluate_classifier(
            cat_model, X_cat_cal, y_cat_cal,
            cat_race_ids_cal, cat_name, ir=cat_ir
        )

        cat_model_path = os.path.join(MODEL_DIR, f"xgb_place_{cat_name}.json")
        cat_model.save_model(cat_model_path)
        print(f"  保存: xgb_place_{cat_name}.json")

        category_metrics[cat_name] = cat_val

    # ==================== メタ情報保存 ====================
    meta = {
        "model_type": "place_classifier_v1",
        "objective": "binary:logistic",
        "place_threshold": PLACE_THRESHOLD,
        "eval_prob_threshold": EVAL_PROB_THRESHOLD,
        "train_samples": len(train_idx),
        "cal_samples": len(cal_idx),
        "test_samples": len(test_idx),
        "feature_count": len(feature_names),
        "calibration": "isotonic_regression",
        "global_scale_pos_weight": round(global_spw, 4),
        "global_val_metrics": val_metrics,
        "global_test_metrics": test_metrics,
        "category_metrics": category_metrics,
        "categories_trained": list(category_metrics.keys()),
    }
    with open(os.path.join(MODEL_DIR, "place_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # ==================== サマリー ====================
    print(f"\n{'=' * 50}")
    print(f"=== 複勝モデル学習完了 (v1.0) ===")
    print(f"{'=' * 50}")
    print(f"グローバル(val): AUC={val_metrics['auc_roc']}, Brier={val_metrics['brier_score']}")
    print(f"グローバル(test): AUC={test_metrics['auc_roc']}, Top3-Acc={test_metrics['top3_accuracy']}")
    for cat_name, cm in category_metrics.items():
        print(f"{cat_name}: AUC={cm['auc_roc']}, Top3-Acc={cm['top3_accuracy']}")
    print(f"モデル保存先: {MODEL_DIR}")


if __name__ == "__main__":
    main()
