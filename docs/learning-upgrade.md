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

## 学习科学与四六级资料

2026-10-08 核验原研究的论文摘要、可公开全文，以及教育部教育考试院官网。研究给出改进方向，不能直接证明本站的具体按钮、间隔或补词数字有效。

| 一手资料 | 可以支持的结论与范围 | 本站采用 |
| --- | --- | --- |
| Karpicke & Roediger (2008), [The Critical Importance of Retrieval for Learning](https://learninglab.psych.purdue.edu/downloads/2008/2008_Karpicke_Roediger_Science.pdf), Science | 外语词对实验中，初次答对后继续提取比仅继续看材料更利于延迟回忆；实验结果不等于所有阅读任务的统一规律 | 认词先尝试回想，再核对选项；「没想起」走辅助学习，不能靠选对选项获得升关证据 |
| Kim & Webb (2022), [The Effects of Spaced Practice on Second Language Learning: A Meta-Analysis](https://onlinelibrary.wiley.com/doi/abs/10.1111/lang.12479), Language Learning | 汇总 48 个实验、3,411 名参与者；总体支持分散练习，延迟测验中较长间隔优于较短间隔，效果受任务和保持时长等影响 | 继续使用 FSRS 安排跨次复习；修复同一轮即时重答重复更新记忆模型的问题，避免高估短时成功 |
| Yanagisawa (2016), [The Effects of Receptive and Productive Word Retrieval Practice on Second Language Vocabulary Learning](https://www.jstage.jst.go.jp/article/katejournal/30/0/30_11/_article/-char/en), KATE Journal | 18 名大学生、24 个拟词的实验；产出练习对产出测验更有帮助，样本较小 | 保留认词与拼写两关，升入拼写独立建立记忆卡，正式拼写前不播放答案 |
| Nakata, Tada, McLean & Kim (2021; 在线发表于 2020), [Effects of Distributed Retrieval Practice Over a Semester](https://onlinelibrary.wiley.com/doi/abs/10.1002/tesq.596), TESOL Quarterly | 72 名大学生、9 周课程中，累计复习旧词的测验优于仅考近期词；不据此承诺本站提升倍数 | 到期旧词优先，已掌握词仍按计划复习，补词考虑积压而非持续堆新词 |
| van den Broek et al. (2022), [Vocabulary Learning During Reading: Benefits of Contextual Inferences Versus Retrieval Opportunities](https://onlinelibrary.wiley.com/doi/abs/10.1111/cogs.13135), Cognitive Science | 两项语境阅读实验中，推断与提取效果受初始学习和反馈影响，不能简单理解成越难回忆越好 | 保留反馈里的例句与搭配；添加独立的语境练习，中文与首字母可按需提示；不把该练习混进正式拼写调度 |
| 教育部教育考试院，[CET 考试大纲入口](https://cet.neea.edu.cn/xhtml1/folder/16113/1588-1.htm)、[2016 修订版大纲](https://www.neea.edu.cn/res/Home/1704/55b02330ac17274664f06d9d3db8249d.pdf)及[分数解释](https://cet.neea.cn/html1/folder/19081/5124-1.htm) | 大纲第 1–8 页涉及听、读、写、译；选词填空考篇章语境中的词汇理解与运用。听力 35%、阅读 35%、写作与翻译共 30%；翻译题不含生僻专业词汇或习语 | 词源、考试相关性和可用例句优先于单纯罕见；添加听音拼写作为声音辨认的补充练习，明确设备合成语音不是真题录音 |

## 本次补充的训练逻辑

1. **先回想，再核对。** 认词题初始隐藏选项。点「想起了」后核对，选对才视为本次独立成功；点「没想起」后借助选项学习，选对也按 Again 安排正式复习。按钮属于自我报告，选择题仍有猜中可能，尚未验证该交互等同于实验中的自由回忆。
2. **将短时练习与正式调度分开。** 错词与提示词至少隔开 3 道题再练，不够间隔则本轮不立即重复；同一轮第二次及后续作答只记练习统计，不改变 FSRS、阶段、升关天数或到期时间。「隔开 3 题」是简洁的交互规则，不是研究证明的最佳间隔；跨次重学仍由 FSRS 安排。
3. **单独练应用。** 语境填空仅选择已学词和含词头的完整例句，先看英文，中文按需揭示；听音拼写先播放单词，不显示词头或释义，支持重播和失败恢复。两种练习不改变正式进度。句长和标点筛选只能排除明显片段，不能保证句子语法和语义正确，例句仍应审核。
4. **反馈区保留学习材料。** 显示词义、例句及译文、已有搭配和例句来源；错拼要求订正，订正不当成额外答对。小结区分错词与提示词，显示独立答对率，两类词都可单独巩固。

本次不新增存档字段、不重置历史记录。累计正确次数继续保留原来的统计含义；小结的独立答对率另按本轮无提示成功计算。灵活补词的 7 个参考量、48 小时 14 个上限、储备及积压阈值仍是可解释的工程保护规则，不能标成记忆科学推导的精确配额。单词辨认、拼写和单句练习是备考的一部分，篇章听力、长篇阅读、写作与翻译仍需要独立训练。

## 数据保护与验证

- 自动迁移前保留原始 JSON；备份写入失败则暂停训练。
- 所有历史 ID 保留，包含已经不在当前词库的记录；迁移不批量重排到期时间。
- 同步保留 FSRS 状态和首次引入时间；新词配额按合并后的引入日期计算，完全离线的两台设备仍可能各自超出共享配额。
- Node 检查实际的迁移、遗忘、提示、加练、认词到拼写的独立记忆卡、每日配额、同步、拼写比较、完整例句挖空边界、选项揭示前禁止评分、提示词延后回练、短队列不立即循环、订正不计分、回练不改变调度、语境与听写模式及发音失败。可传入私有旧存档做逐字段兼容检查。
- 网页脚本使用版本化 URL，避免新 HTML 第一次加载时被旧 service worker 配上旧算法；FSRS 本地资源一并纳入离线缓存。
- 浏览器实测核对前选项不可见、数字键无法评分，未作答不能继续；提示词隔开三题再练且正式调度不变。检查语境提示、听写不显示答案、重播和语音失败恢复，原生语音收到播放完成事件。修复 CSS 覆盖 `hidden` 的旧问题，并验证窄屏与 200% 字号下的输入框、顶栏和回忆按钮。

## 第三方依赖

`vendor/ts-fsrs-5.4.2.js` 为 npm 官方 `ts-fsrs@5.4.2` 的 `dist/index.umd.js` 浏览器构建（仅清理行末空白），许可证在 `vendor/ts-fsrs.LICENSE`。下载包验证 SHA-512 integrity：

```
sha512-z4qop4pzTcyTzuJ566d9EaX/4bZZzhYfeaPImfVr+xcYT65c5oBgFDijUhCE/D+C78eaolHIhKRZ04/RwF+v2g==
```

未增加账号后端、参数优化器或构建工具。现有记录缺少完整评分历史，暂用维护库的默认模型参数。
