# WordDrill · 背单词

一个只为自己做的单词训练器。核心是一条规矩：**先认得出，再写得出。**
词从「未开始 → 认词中 → 拼写中 → 已掌握」逐级推进，没过前一关不会让你去拼它。

纯静态站点，进度存在浏览器本地，不联网、不上传任何数据。

## 怎么用

直接打开 `index.html` 所在的站点即可（首次使用建议「添加到主屏幕」，可离线）。

- **训练** — 点「开始训练」。选择题用键盘 `1`–`4` 作答，`Enter` 进入下一题。
  答错的词会在本轮稍后重现；答对但本关还没累计够次数，也会重现，直到过关。
- **词库** — 看熟练度分布、按阶段筛选、搜索单词。每条显示释义、例句、对错次数和下次复习时间。
- **设置** — 每日新词上限、升阶所需连续答对次数、发音开关、进度导出/导入/清空。

## 记忆模型

| 阶段 | 出题方式 | 过关条件 |
| --- | --- | --- |
| 未开始 | 认词（四选一） | 首次答对即进入「认词中」 |
| 认词中 | 认词（四选一） | 连续答对 `threshold` 次 → 「拼写中」 |
| 拼写中 | 拼写（看中文写英文） | 连续答对 `threshold` 次 → 「已掌握」 |
| 已掌握 | 拼写 / 例句填空 | 答错即退回「拼写中」 |

- `threshold` 默认 2，可在设置里调到 1–4。
- 复习间隔按阶段给：认词中 15 分钟、拼写中 6 小时、已掌握 3 天。
- 答错时强度 -1，连续答对次数清零；已掌握的词答错直接降回拼写关。

## 目录结构

```
index.html              页面骨架（图标全部内联 SVG，没有 emoji）
styles.css              设计系统：浅/深色主题变量、间距、焦点环、响应式
app.js                  全部逻辑（SRS 调度、出题、渲染、快捷键）
data/words.json         词库 —— 唯一需要维护的数据文件
scripts/               FlowUs → 词库 的同步脚本
manifest.webmanifest    PWA 清单
sw.js                   Service worker（静态资源 stale-while-revalidate）
icon.svg / icon-maskable.svg
```

## 加新词（日常流程）

1. 在 FlowUs 的「生词」页按现有格式记下新词；
2. 跑同步脚本，把 FlowUs 拉到本地词库：

```bash
# 预览会改什么，不写盘
python3 scripts/sync-from-flowus.py --dry-run

# 真正同步（FlowUs 为准，本地已有的搭配/标签会保留）
python3 scripts/sync-from-flowus.py
```

3. 提交并推送，站点自动更新。

也可以直接编辑 `data/words.json`。每条的结构：

```json
{
  "id": "unveil",
  "word": "unveil",
  "pos": "v.",
  "meaning": "揭开，公布；为…揭幕",
  "example": "The company will unveil its new concept car next month.",
  "exampleZh": "该公司下月将发布新款概念车。",
  "collocations": ["unveil a plan"],
  "tags": []
}
```

> `id` 要唯一且稳定 —— 学习进度是按 `id` 索引的，改了 `id` 等于把它当成新词。

## 数据说明

进度存在 `localStorage` 的 `worddrill.v1` 键下，包含每个词的阶段、强度、对错次数、下次复习时间和全局设置。
换设备时用设置里的「导出进度 / 导入进度」搬运。清缓存会清掉进度，词库不受影响。
