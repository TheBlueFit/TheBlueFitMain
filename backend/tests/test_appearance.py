"""Appearance policy incl. new styles / colours / menu blur. Run: python3 test_appearance.py"""
import copy, time
from harness import main as M, TABLE, HTTPException

ok = bad = 0
def check(label, cond):
    global ok, bad
    print(("  PASS  " if cond else "  FAIL  ") + label); ok += bool(cond); bad += (not cond)
def status_of(fn, *a, **k):
    try: fn(*a, **k)
    except HTTPException as e: return e.status_code
    return 200

TABLE.put_item({"PK": "ADMIN#AP1", "SK": M.PROFILE_SK, "role": "ADMIN", "name": "A", "userCode": "AP1", "status": "ACTIVE", "pwdChangedAt": int(time.time()) - 5})
TABLE.put_item({"PK": "CLIENT#AC1", "SK": M.PROFILE_SK, "role": "CLIENT", "name": "C", "status": "ACTIVE", "pwdChangedAt": int(time.time()) - 5})
admin = {"pk": "ADMIN#AP1", "role": "ADMIN", "userCode": "AP1"}
client = {"pk": "CLIENT#AC1", "role": "CLIENT"}

print("== defaults ==")
pol = M.get_my_appearance_policy(client)["policy"]
check("all 8 styles offered by default", set(pol["styles"]) == {"original","glass","vintage","oldgym","moderngym","navy","forest","coral"})
check("new colours offered", {"azure","emerald","coral"} <= set(pol["palettes"]))
check("menu blur allowed, default soft", pol["allowBlur"] is True and pol["defaults"]["blur"] == "soft")
check("existing defaults unchanged (original / classic)", pol["defaults"]["style"] == "original" and pol["defaults"]["palette"] == "classic")

print("== admin saves ==")
full = M.admin_get_appearance_policy(admin)
roles = copy.deepcopy(full["roles"])
roles["CLIENT"]["defaults"].update({"style": "navy", "palette": "azure", "blur": "strong"})
roles["CLIENT"]["allowBlur"] = False
saved = M.admin_save_appearance_policy(M.AppearancePolicyPayload(roles=roles), admin)
check("Navy Pulse + Azure + strong blur saved as client default", saved["roles"]["CLIENT"]["defaults"]["style"] == "navy" and saved["roles"]["CLIENT"]["defaults"]["blur"] == "strong")
check("coach untouched", saved["roles"]["COACH"]["defaults"]["style"] == "original")
check("client reads the new slice", M.get_my_appearance_policy(client)["policy"]["allowBlur"] is False)

print("== validation ==")
bad_roles = copy.deepcopy(roles); bad_roles["CLIENT"]["defaults"]["blur"] = "extreme"
check("unknown blur rejected", status_of(M.admin_save_appearance_policy, M.AppearancePolicyPayload(roles=bad_roles), admin) == 400)
bad_roles = copy.deepcopy(roles); bad_roles["CLIENT"]["styles"] = ["original", "disco"]
check("unknown style rejected", status_of(M.admin_save_appearance_policy, M.AppearancePolicyPayload(roles=bad_roles), admin) == 400)
bad_roles = copy.deepcopy(roles); bad_roles["CLIENT"]["styles"] = ["original"]
check("default style must stay allowed", status_of(M.admin_save_appearance_policy, M.AppearancePolicyPayload(roles=bad_roles), admin) == 400)

print("== settings saved before these options existed ==")
TABLE.put_item({**M.APPEARANCE_KEY, "type": "SETTINGS", "updatedAt": "x", "roles": {"CLIENT": {
    "allowCustomize": True, "styles": ["original", "glass"], "palettes": ["classic"], "scenes": ["auto"], "themes": ["dark"],
    "allowMotionToggle": True, "allowVibrancy": True, "resetCounter": 2,
    "defaults": {"style": "original", "palette": "classic", "scene": "auto", "theme": "dark", "motion": "on", "vibrancy": 100}}}})
old = M.get_my_appearance_policy(client)["policy"]
check("old policy gains blur defaults instead of missing keys", old["defaults"]["blur"] == "soft" and old["allowBlur"] is True)
check("old policy keeps its restrictions (new styles stay off until the admin enables them)", old["styles"] == ["original", "glass"])
check("reset counter preserved", old["resetCounter"] == 2)

print("== depth (3D) ==")
TABLE.put_item({**M.APPEARANCE_KEY, "type": "SETTINGS", "updatedAt": "x", "roles": {}})
pol = M.get_my_appearance_policy(client)["policy"]
check("all depths offered, Subtle by default", pol["depths"] == ["off", "subtle", "immersive"] and pol["defaults"]["depth"] == "subtle")
roles = copy.deepcopy(M.admin_get_appearance_policy(admin)["roles"])
roles["CLIENT"]["depths"] = ["subtle", "immersive"]; roles["CLIENT"]["defaults"]["depth"] = "immersive"
saved = M.admin_save_appearance_policy(M.AppearancePolicyPayload(roles=roles), admin)
check("admin can make Immersive the client default and hide Flat", saved["roles"]["CLIENT"]["depths"] == ["subtle", "immersive"] and saved["roles"]["CLIENT"]["defaults"]["depth"] == "immersive")
check("client reads the depth policy", M.get_my_appearance_policy(client)["policy"]["defaults"]["depth"] == "immersive")
bad_roles = copy.deepcopy(roles); bad_roles["CLIENT"]["depths"] = ["subtle", "hyper"]
check("unknown depth rejected", status_of(M.admin_save_appearance_policy, M.AppearancePolicyPayload(roles=bad_roles), admin) == 400)
bad_roles = copy.deepcopy(roles); bad_roles["CLIENT"]["depths"] = ["off"]
check("default depth must stay allowed", status_of(M.admin_save_appearance_policy, M.AppearancePolicyPayload(roles=bad_roles), admin) == 400)
legacy = copy.deepcopy(roles); legacy["CLIENT"].pop("depths"); legacy["CLIENT"]["defaults"].pop("depth")
kept = M.admin_save_appearance_policy(M.AppearancePolicyPayload(roles=legacy), admin)["roles"]["CLIENT"]
check("an older admin screen (no depth fields) keeps the saved depth list", kept["depths"] == ["subtle", "immersive"] and kept["defaults"]["depth"] == "subtle")

print(f"\n{ok} passed, {bad} failed"); raise SystemExit(1 if bad else 0)
