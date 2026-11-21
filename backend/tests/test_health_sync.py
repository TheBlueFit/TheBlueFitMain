"""Automated Health Sync & Apple Health Shortcut Ingest Tests.
Run: python3 test_health_sync.py
"""
import asyncio
import time
from harness import main as M, TABLE, HTTPException

ok = bad = 0


def check(label, cond):
    global ok, bad
    print(("  PASS  " if cond else "  FAIL  ") + label)
    ok += cond
    bad += not cond


def status_of(fn, *a, **k):
    try:
        fn(*a, **k)
    except HTTPException as e:
        return e.status_code
    return 200


class Req:
    def __init__(self, body):
        self._b = body

    async def json(self):
        if isinstance(self._b, Exception):
            raise self._b
        return self._b


def ingest(body, auth):
    return asyncio.run(M.health_sync_ingest(Req(body), authorization=auth))


def ingest_status(body, auth):
    try:
        ingest(body, auth)
        return 200
    except HTTPException as e:
        return e.status_code


PK = "CLIENT#TBF-TEST0001"
TABLE.put_item({
    "PK": PK,
    "SK": M.PROFILE_SK,
    "role": "CLIENT",
    "name": "Test Athlete",
    "status": "ACTIVE",
    "pwdChangedAt": int(time.time()) - 5,
})
user = {"pk": PK, "role": "CLIENT"}

print("== Apple Health key lifecycle ==")
check("status disabled at first", M.health_sync_status(user)["enabled"] is False)
key = M.create_health_sync_key(user)["key"]
check("key has bfh.<id>.<secret> shape", key.startswith("bfh.TBF-TEST0001."))
stored = TABLE.get_item({"PK": PK, "SK": M.HEALTH_SYNC_SK})["Item"]
check("only a hash is stored, never the secret", key.split(".", 2)[2] not in str(stored))

print("== Apple Health shortcut ingest ==")
today = M.utc_today()
r = ingest(
    {"steps": "8,421 count", "sleepMinutes": "450", "calories": 512.4, "heartRate": "61 bpm", "date": today},
    f"Bearer {key}",
)
snap = TABLE.get_item({"PK": PK, "SK": f"HEALTH#{today}"})["Item"]
check("returns date", r["date"] == today)
check("text numbers parsed (steps)", snap["steps"] == 8421)
check("minutes -> hours", float(snap["sleepHours"]) == 7.5)
check("calories rounded / hr parsed", snap["calories"] == 512 and snap["heartRate"] == 61)
check("source tagged apple-health", snap["source"] == "apple-health")
check("lastUsedAt recorded", M.health_sync_status(user).get("lastUsedAt") is not None)
ingest({"steps": 9000}, f"Bearer {key}")
snap = TABLE.get_item({"PK": PK, "SK": f"HEALTH#{today}"})["Item"]
check("partial update keeps other fields", snap["steps"] == 9000 and snap["heartRate"] == 61)

print("== Apple Health rejections ==")
check("no header -> 401", ingest_status({"steps": 1}, None) == 401)
check("wrong secret -> 401", ingest_status({"steps": 1}, f"Bearer {key[:-3]}abc") == 401)
check("session JWT is not accepted", ingest_status({"steps": 1}, "Bearer a.b.c") == 401)
check(
    "other athlete's id + my secret -> 401",
    ingest_status({"steps": 1}, "Bearer bfh.TBF-OTHER." + key.split(".", 2)[2]) == 401,
)
check("out-of-range steps -> 400", ingest_status({"steps": 999999}, f"Bearer {key}") == 400)
check("empty body -> 400", ingest_status({}, f"Bearer {key}") == 400)
check("array body -> 400", ingest_status([1], f"Bearer {key}") == 400)
check("old date -> 400", ingest_status({"steps": 5, "date": "2020-01-01"}, f"Bearer {key}") == 400)

print("== Android Health Connect automated sync contract ==")
res_auto = M.save_health_metrics(
    M.HealthMetricsPayload(
        steps=10450,
        sleepHours=7.8,
        calories=620,
        heartRate=64,
        distanceKm=7.95,
        date=today,
        source="health-connect",
        provider="com.google.android.apps.healthdata",
        platform="android",
        syncMode="automated",
        sensorTimestamp=M.now_iso(),
    ),
    user=user,
)
snap_android = TABLE.get_item({"PK": PK, "SK": f"HEALTH#{today}"})["Item"]
check("Android automated sync succeeds and returns verified=True", res_auto.get("verified") is True)
check("Android steps & distance stored", snap_android["steps"] == 10450 and float(snap_android["distanceKm"]) == 7.95)
check(
    "Android provider metadata persisted",
    snap_android["source"] == "health-connect"
    and snap_android["provider"] == "com.google.android.apps.healthdata"
    and snap_android["syncMode"] == "automated"
    and snap_android["verified"] is True,
)

print("== Android manual override rejections (tamper-proof enforcement) ==")
check(
    "Android manual step override rejected -> 400",
    status_of(
        M.save_health_metrics,
        M.HealthMetricsPayload(steps=15000, date=today, source="manual", platform="android"),
        user=user,
    )
    == 400,
)
check(
    "Manual step override without provider rejected -> 400",
    status_of(
        M.save_health_metrics,
        M.HealthMetricsPayload(steps=12000, calories=500, date=today, source="manual", platform="android"),
        user=user,
    )
    == 400,
)
check(
    "Android sync missing provider metadata rejected -> 400",
    status_of(
        M.save_health_metrics,
        M.HealthMetricsPayload(steps=8000, date=today, source="health-connect", platform="android"),
        user=user,
    )
    == 400,
)
check(
    "Android sync with syncMode='manual' rejected -> 400",
    status_of(
        M.save_health_metrics,
        M.HealthMetricsPayload(
            steps=8000,
            date=today,
            source="health-connect",
            provider="com.google.android.apps.healthdata",
            platform="android",
            syncMode="manual",
        ),
        user=user,
    )
    == 400,
)
check(
    "Android sync with untrusted provider rejected -> 400",
    status_of(
        M.save_health_metrics,
        M.HealthMetricsPayload(
            steps=8000,
            date=today,
            source="health-connect",
            provider="com.fake.stepcounter",
            platform="android",
            syncMode="automated",
        ),
        user=user,
    )
    == 400,
)
check(
    "Hydration-only log allowed without overwriting automated steps",
    status_of(
        M.save_health_metrics,
        M.HealthMetricsPayload(hydration=3.2, date=today, source="hydration-log", platform="android"),
        user=user,
    )
    == 200
    and TABLE.get_item({"PK": PK, "SK": f"HEALTH#{today}"})["Item"]["steps"] == 10450
    and float(TABLE.get_item({"PK": PK, "SK": f"HEALTH#{today}"})["Item"]["hydration"]) == 3.2,
)

print("== rotate / revoke ==")
key2 = M.create_health_sync_key(user)["key"]
check("old key dies when a new one is made", ingest_status({"steps": 5}, f"Bearer {key}") == 401)
check("new key works", ingest_status({"steps": 5}, f"Bearer {key2}") == 200)
M.revoke_health_sync_key(user)
check("revoked key -> 401", ingest_status({"steps": 5}, f"Bearer {key2}") == 401)
TABLE.put_item({"PK": PK, "SK": M.HEALTH_SYNC_SK, "keyHash": M._sync_hash(key2.split(".", 2)[2]), "createdAt": "x"})
TABLE.update_item({"PK": PK, "SK": M.PROFILE_SK}, "SET #s = :s", {":s": "INACTIVE"}, {"#s": "status"})
check("deactivated athlete -> 401", ingest_status({"steps": 5}, f"Bearer {key2}") == 401)

print(f"\n{ok} passed, {bad} failed")
raise SystemExit(1 if bad else 0)