"""
XGBoost ML推論 - Vercel Python Serverless Function

POST /api/ml-predict
Body: { "horses": [{ "horseNumber": 1, "features": { "recentForm": 72, ... } }] }
Response: { "success": true, "predictions": { "1": { "winProb": 0.15, "placeProb": 0.45 } } }
"""

import json
import os
from http.server import BaseHTTPRequestHandler

# グローバルキャッシュ（warm lambda間で再利用）
_model_win = None
_model_place = None
_feature_names = None


def load_models():
    global _model_win, _model_place, _feature_names
    if _model_win is not None:
        return

    import xgboost as xgb

    model_dir = os.path.join(os.path.dirname(__file__), '..', 'model')

    win_path = os.path.join(model_dir, 'xgb_win.json')
    place_path = os.path.join(model_dir, 'xgb_place.json')
    names_path = os.path.join(model_dir, 'feature_names.json')

    if not os.path.exists(win_path) or not os.path.exists(place_path):
        raise FileNotFoundError('Model files not found. Run training in Colab first.')

    _model_win = xgb.XGBClassifier()
    _model_win.load_model(win_path)

    _model_place = xgb.XGBClassifier()
    _model_place.load_model(place_path)

    with open(names_path, 'r', encoding='utf-8') as f:
        _feature_names = json.load(f)


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(content_length))

            load_models()

            import numpy as np

            horse_numbers = []
            feature_matrix = []

            for horse in body.get('horses', []):
                horse_numbers.append(horse['horseNumber'])
                features = horse.get('features', {})
                row = [float(features.get(name, 0.0)) for name in _feature_names]
                feature_matrix.append(row)

            if len(feature_matrix) == 0:
                self._send_json(200, {'success': True, 'predictions': {}})
                return

            X = np.array(feature_matrix, dtype=np.float32)

            win_probs = _model_win.predict_proba(X)[:, 1].tolist()
            place_probs = _model_place.predict_proba(X)[:, 1].tolist()

            result = {}
            for i, hn in enumerate(horse_numbers):
                result[str(hn)] = {
                    'winProb': round(win_probs[i], 6),
                    'placeProb': round(place_probs[i], 6),
                }

            self._send_json(200, {'success': True, 'predictions': result})

        except FileNotFoundError as e:
            self._send_json(503, {'success': False, 'error': str(e)})
        except Exception as e:
            self._send_json(500, {'success': False, 'error': str(e)})

    def _send_json(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def log_message(self, format, *args):
        pass
