#!/usr/bin/env python3
"""把桌面上「words in Unit1.pptx」里的生词加进词库（一次性脚本）。

PPT 是 Unit 1 · Word Study，共 10 个词；allure / resolute 词库已有，只加剩下 8 个。
例句直接取自 PPT（保留原句），中文翻译据 PPT 释义与例句写成。
"""
import json
import re
from datetime import datetime
from pathlib import Path

WORDS_FILE = Path("/Users/drivinggodj/WorkBuddy/2026-09-18-19-35-22/word-drill/data/words.json")
TAG = "Unit1"

NEW = [
    {
        "word": "hassle",
        "pos": "n./v.",
        "meaning": "麻烦，烦人的事（口语）；v. 不断烦扰，纠缠",
        "example": "It was a big hassle trying to find parking in the crowded downtown area.",
        "exampleZh": "在拥挤的市中心找停车位真是件麻烦事。",
        "collocations": ["a lot of hassle", "hassle-free", "go through the hassle", "get hassled by"],
    },
    {
        "word": "cobble",
        "pos": "vt.",
        "meaning": "（~ together）匆忙拼凑，草草凑成",
        "example": "With limited resources and a tight deadline, the team managed to cobble together a workable prototype.",
        "exampleZh": "资源有限、工期又紧，团队还是设法仓促拼凑出一个可用的原型。",
        "collocations": ["cobble together", "cobble sth. together"],
    },
    {
        "word": "courier",
        "pos": "n./v.",
        "meaning": "快递员；快递公司；v. 用快递寄送",
        "example": "The courier company guaranteed same-day delivery for all packages within the metropolitan area.",
        "exampleZh": "这家快递公司承诺大都市区内的所有包裹当日送达。",
        "collocations": ["diplomatic courier", "same-day courier", "courier tracking"],
    },
    {
        "word": "sun-drenched",
        "pos": "adj.",
        "meaning": "阳光充足的，阳光普照的",
        "example": "The sun-drenched balcony was the perfect spot for her morning coffee and quiet reflection.",
        "exampleZh": "那个阳光充沛的阳台是她早晨喝咖啡、安静沉思的绝佳去处。",
        "collocations": [],
    },
    {
        "word": "sanctuary",
        "pos": "n.",
        "meaning": "避难所，庇护所；（鸟兽）保护区，禁猎区",
        "example": "The old church became a sanctuary for villagers seeking safety during the war.",
        "exampleZh": "战争期间，这座老教堂成了村民寻求安全的避难所。",
        "collocations": ["seek sanctuary", "offer sanctuary", "a wildlife sanctuary"],
    },
    {
        "word": "aromatic",
        "pos": "adj.",
        "meaning": "芳香的，香气浓郁的",
        "example": "She brewed an aromatic cup of coffee that instantly lifted everyone's spirits that morning.",
        "exampleZh": "那天早上她煮了一杯香气浓郁的咖啡，立刻让大家心情振奋。",
        "collocations": [],
    },
    {
        "word": "embark",
        "pos": "v.",
        "meaning": "（~ on/upon）开始，着手（尤指新而艰难的事）；上船（或飞机）",
        "example": "She was excited to embark on her new career even though challenges lay ahead.",
        "exampleZh": "尽管前路充满挑战，她仍为踏上新的职业道路而兴奋。",
        "collocations": ["embark on/upon", "embarkation point", "re-embark"],
    },
    {
        "word": "dazzle",
        "pos": "v.",
        "meaning": "（强光）使目眩，使眼花；使赞叹不已，使倾倒",
        "example": "The chef's innovative dish dazzled by combining flavors and textures in a way that delighted every guest.",
        "exampleZh": "那位厨师的创意菜品把风味与口感巧妙结合，令每位客人都赞叹不已。",
        "collocations": ["dazzle sb. with sth.", "be dazzled by"],
    },
]


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def main() -> None:
    data = json.loads(WORDS_FILE.read_text(encoding="utf-8"))
    words = data["words"]
    have = {w["id"] for w in words}

    added, skipped = [], []
    for item in NEW:
        wid = slug(item["word"])
        if wid in have:
            skipped.append(item["word"])
            continue
        words.append({
            "id": wid,
            "word": item["word"],
            "pos": item["pos"],
            "meaning": item["meaning"],
            "example": item["example"],
            "exampleZh": item["exampleZh"],
            "collocations": item["collocations"],
            "tags": [TAG],
        })
        have.add(wid)
        added.append(item["word"])

    words.sort(key=lambda w: w["word"].lower())
    data["words"] = words
    data.setdefault("meta", {})["updated"] = datetime.now().astimezone().date().isoformat()
    WORDS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"新增 {len(added)} 个：{'、'.join(added)}")
    if skipped:
        print(f"已存在跳过：{'、'.join(skipped)}")
    print(f"词库现为 {len(words)} 个词")


if __name__ == "__main__":
    main()
