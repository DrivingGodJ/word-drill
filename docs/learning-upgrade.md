# 学习逻辑改进 · 2026-10-08

本次保留认词 → 拼写的两阶段流程、FlowUs 词库和私有 GitHub 同步。改进针对原版固定 20 分钟复习、一次答错清空跨天积累、新词上限实际按每轮计算，以及拼写前自动发音透露答案的问题。

## 研究与采用

| 项目 / 来源 | 核验内容 | 本站采用 |
| --- | --- | --- |
| [Anki](https://github.com/ankitects/anki)（约 3.18 万 stars）及[官方复习设置](https://docs.ankiweb.net/manual/deck-options) | FSRS、目标记忆率、短期重学、每日新词配额、积压复习优先 | 90% 目标、自适应间隔、短期回练、真正按自然日限额、最早到期优先 |
| [Qwerty Learner](https://github.com/RealKai42/qwerty-learner)（约 2.33 万 stars）及[本轮结果代码](https://github.com/RealKai42/qwerty-learner/blob/master/src/pages/Typing/components/ResultScreen/index.tsx) | 默写、错误后重新输入、独立错词列表、重复练习与训练反馈 | 隐藏提示、拼错订正、本轮错词小结与重练、历史错词筛选 |
| [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) 和[算法说明](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm) | FSRS-6 维护实现、记忆卡状态、日期序列化、评分与回忆成功的含义 | 使用固定 5.4.2 UMD 包，随站点缓存，保留 MIT 许可证 |

Stars 是当日 GitHub API 快照，用来识别成熟项目，不能代表算法适合程度。Qwerty 的交互思路由本站自己实现，没有复制其 GPL 源码。FSRS 数学实现直接复用 MIT 包，未手写简化版。

## 本站的升关规则

复习间隔与升关证据分别判断。默认至少 3 个不同日子无提示、到期答对，认词稳定性还需达到 7 天，拼写达到 21 天。它们是本站的保守门槛，尚未通过个人学习效果实验校准，不宣称为 Anki 或 FSRS 的官方升关规则。

历史答对天数不再过期；答错保留过去的积累，只撤销今天的证据。独立答对记 Good，答错和提示答对记 Again；自由加练只记录统计，不改变正式复习时间或记忆卡。升入拼写后重新建立拼写卡，防止认词能力替代独立拼写能力。

旧版没有每一次作答的完整评分和间隔，所以不拿旧的总次数伪造复习日志。历史阶段、累计天数和到期时间在迁移时保留，从下一次正式作答建立 FSRS 卡。新格式和旧格式的学习参数不混用，避免旧设备把新门槛覆盖。

## 数据保护与验证

- 自动迁移前保留原始 JSON；备份写入失败则暂停训练。
- 所有历史 ID 保留，包含已经不在当前词库的记录；迁移不批量重排到期时间。
- 同步保留 FSRS 状态和首次引入时间；新词配额按合并后的引入日期计算，完全离线的两台设备仍可能各自超出共享配额。
- Node 检查实际的迁移、遗忘、提示、加练、认词到拼写的独立记忆卡、每日配额、同步、拼写比较和例句挖空边界。可传入私有旧存档做逐字段兼容检查。
- 网页脚本使用版本化 URL，避免新 HTML 第一次加载时被旧 service worker 配上旧算法；FSRS 本地资源一并纳入离线缓存。

## 第三方依赖

`vendor/ts-fsrs-5.4.2.js` 为 npm 官方 `ts-fsrs@5.4.2` 的 `dist/index.umd.js` 原文件，许可证在 `vendor/ts-fsrs.LICENSE`。下载包验证 SHA-512 integrity：

```
sha512-z4qop4pzTcyTzuJ566d9EaX/4bZZzhYfeaPImfVr+xcYT65c5oBgFDijUhCE/D+C78eaolHIhKRZ04/RwF+v2g==
```

未增加账号后端、参数优化器或构建工具。现有记录缺少完整评分历史，暂用维护库的默认模型参数。
