"""Push-notification device registry + message hook. Run: python3 test_push.py"""
import time
from harness import main as M, TABLE, HTTPException

ok = bad = 0
def check(label, cond):
    global ok, bad
    print(("  PASS  " if cond else "  FAIL  ") + label); ok += bool(cond); bad += (not cond)
def status_of(fn, *a, **k):
    try: fn(*a, **k)
    except HTTPException as e: return e.status_code
    return 200

now = int(time.time()) - 5
for pk, role, name in (("CLIENT#PC1", "CLIENT", "Asha"), ("COACH#PH1", "COACH", "Coach Ravi"), ("CLIENT#PC2", "CLIENT", "Other")):
    TABLE.put_item({"PK": pk, "SK": M.PROFILE_SK, "role": role, "name": name, "status": "ACTIVE", "pwdChangedAt": now,
                    **({"coachId": "COACH#PH1"} if pk == "CLIENT#PC1" else {})})
client = {"pk": "CLIENT#PC1", "role": "CLIENT", "name": "Asha"}
coach = {"pk": "COACH#PH1", "role": "COACH", "name": "Coach Ravi"}
other = {"pk": "CLIENT#PC2", "role": "CLIENT", "name": "Other"}
TOK_A, TOK_B = "A" * 40, "B" * 40

print("== register / unregister ==")
check("short token rejected", status_of(M.register_device, M.DevicePayload(token="abc"), user=client) == 400)
check("token with whitespace rejected", status_of(M.register_device, M.DevicePayload(token="x" * 30 + " y"), user=client) == 400)
check("bad platform rejected", status_of(M.register_device, M.DevicePayload(token=TOK_A, platform="symbian"), user=client) == 400)
check("register ok", status_of(M.register_device, M.DevicePayload(token=TOK_A, platform="android"), user=client) == 200)
M.register_device(M.DevicePayload(token=TOK_A, platform="android"), user=client)
rows = [k for k in TABLE.d if k[0] == "CLIENT#PC1" and k[1].startswith("DEVICE#")]
check("registering twice keeps one row", len(rows) == 1)
check("coach can register too", status_of(M.register_device, M.DevicePayload(token=TOK_B, platform="android"), user=coach) == 200)

print("== phone changes hands ==")
M.register_device(M.DevicePayload(token=TOK_A, platform="android"), user=other)
check("previous owner's row removed", not [k for k in TABLE.d if k[0] == "CLIENT#PC1" and k[1].startswith("DEVICE#")])
check("new owner has the row", [k for k in TABLE.d if k[0] == "CLIENT#PC2" and k[1].startswith("DEVICE#")])
M.unregister_device(M.DevicePayload(token=TOK_A), user=other)
check("sign-out removes row and owner marker", not [k for k in TABLE.d if k[1].startswith("DEVICE#") and k[0] == "CLIENT#PC2"]
      and (f"DEVICE#{M._device_id(TOK_A)}", "OWNER") not in TABLE.d)

print("== device cap ==")
for i in range(8):
    M.register_device(M.DevicePayload(token=f"{i}" * 40, platform="android"), user=client); time.sleep(0.003)
check("at most 5 phones per person", len([k for k in TABLE.d if k[0] == "CLIENT#PC1" and k[1].startswith("DEVICE#")]) == M.MAX_DEVICES_PER_USER)

print("== sending ==")
sent = []
M.FCM_SECRET_ARN = "arn:fake"
def fake_post(token, message):
    sent.append((token, message)); return 404 if token.startswith("DEAD") else 200
M._fcm_post = fake_post
sent.clear()
M.register_device(M.DevicePayload(token="C" * 40), user=coach)
M.send_message("PC1", M.MessagePayload(text="Knee feels better today"), user=client)
check("client message pushes to the coach's phones only", sent and all(t in ("B" * 40, "C" * 40) for t, _ in sent))
m = sent[0][1]
check("title is sender name, body is the text", m["notification"]["title"] == "Asha" and m["notification"]["body"] == "Knee feels better today")
check("deep link opens that client's thread", m["data"]["url"] == "/coach/messages?client=PC1")
check("android channel + collapse tag set", m["android"]["notification"]["channel_id"] == "messages" and m["android"]["notification"]["tag"] == "msg-PC1")
sent.clear()
M.send_message("PC1", M.MessagePayload(text="Great, keep going"), user=coach)
check("coach reply pushes to the client's phones", len(sent) == M.MAX_DEVICES_PER_USER and sent[0][1]["data"]["url"] == "/client/messages")
check("long text is trimmed", len(sent[0][1]["notification"]["body"]) <= 140)

print("== failure handling ==")
M.register_device(M.DevicePayload(token="DEAD" + "x" * 36), user=coach)
sent.clear()
M.send_message("PC1", M.MessagePayload(text="ping"), user=client)
check("retired token (404) is deleted", (f"DEVICE#{M._device_id('DEAD' + 'x' * 36)}", "OWNER") not in TABLE.d
      and not [k for k in TABLE.d if k[0] == "COACH#PH1" and k[1] == f"DEVICE#{M._device_id('DEAD' + 'x' * 36)}"])
def boom(token, message): raise RuntimeError("network down")
M._fcm_post = boom
check("push outage never fails the message send", status_of(M.send_message, "PC1", M.MessagePayload(text="still sends"), user=client) == 200)
M.FCM_SECRET_ARN = None
check("push disabled (no secret) -> send still works", status_of(M.send_message, "PC1", M.MessagePayload(text="no fcm"), user=client) == 200)

print(f"\n{ok} passed, {bad} failed"); raise SystemExit(1 if bad else 0)
