from app import app


def test_health():
    client = app.test_client()
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json["status"] == "ok"


def test_metrics():
    client = app.test_client()
    res = client.get("/api/metrics")
    assert res.status_code == 200
    assert "series" in res.json
