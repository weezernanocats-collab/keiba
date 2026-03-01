"""
XGBoost ML inference endpoint for Vercel Python Runtime.

Receives 29-dimensional feature vectors per horse, runs XGBoost
inference, and returns win/place probabilities.

Falls back gracefully: if model files are missing, returns 500
which triggers null fallback in the TypeScript client.
"""

import json
import os
from http.server import BaseHTTPRequestHandler

# Global model cache (persisted across warm lambda invocations)
_win_model = None
_place_model = None
_feature_names = None


def _load_models():
    global _win_model, _place_model, _feature_names

    if _win_model is not None:
        return True

    model_dir = os.path.join(os.path.dirname(__file__), '..', 'model')

    win_path = os.path.join(model_dir, 'xgb_win.json')
    place_path = os.path.join(model_dir, 'xgb_place.json')
    names_path = os.path.join(model_dir, 'feature_names.json')

    if not os.path.exists(win_path) or not os.path.exists(place_path):
        return False

    try:
        import xgboost as xgb

        _win_model = xgb.XGBClassifier()
        _win_model.load_model(win_path)

        _place_model = xgb.XGBClassifier()
        _place_model.load_model(place_path)

        if os.path.exists(names_path):
            with open(names_path, 'r') as f:
                _feature_names = json.load(f)

        return True
    except Exception as e:
        print(f"Model load error: {e}")
        _win_model = None
        _place_model = None
        return False


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            data = json.loads(body)

            horses = data.get('horses', [])
            if not horses:
                self._json_response(400, {'success': False, 'error': 'No horses provided'})
                return

            if not _load_models():
                self._json_response(500, {
                    'success': False,
                    'error': 'Model files not found. Train and deploy models first.',
                })
                return

            import numpy as np

            predictions = {}
            for horse in horses:
                horse_number = horse.get('horseNumber')
                features = horse.get('features', {})

                if _feature_names:
                    feature_vector = [features.get(name, 0.0) for name in _feature_names]
                else:
                    feature_vector = list(features.values())

                x = np.array([feature_vector], dtype=np.float32)

                win_prob = float(_win_model.predict_proba(x)[0][1])
                place_prob = float(_place_model.predict_proba(x)[0][1])

                predictions[str(horse_number)] = {
                    'winProb': round(win_prob, 6),
                    'placeProb': round(place_prob, 6),
                }

            self._json_response(200, {'success': True, 'predictions': predictions})

        except Exception as e:
            self._json_response(500, {'success': False, 'error': str(e)})

    def _json_response(self, status_code, data):
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))
