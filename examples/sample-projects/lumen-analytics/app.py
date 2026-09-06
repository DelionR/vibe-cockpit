"""Lumen Analytics — мини-дашборд на Flask."""
from flask import Flask, jsonify
import pandas as pd

app = Flask(__name__)


@app.route("/health")
def health():
    return jsonify(status="ok")


@app.route("/api/metrics")
def metrics():
    df = pd.DataFrame({"x": [1, 2, 3], "y": [4, 5, 6]})
    return jsonify(series=df.to_dict(orient="list"))


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000)
