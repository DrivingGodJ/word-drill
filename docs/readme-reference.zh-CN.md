# 软件与私有数据分离

公开 `word-drill` 只发布应用、算法、工具和 Skill。每个私有数据仓库保存：

- `data/words.json`：`{ "meta": { "name": "词表名称" }, "words": [...] }`；词条需要唯一稳定的 `id`、`word`、`meaning`，可含词性、例句、中译、搭配和标签。
- `progress.json`：学习进度，由客户端读取、逐词合并并带 SHA 写入。
- 可选 `data/distractors.json`、`data/cet-pending.json`、`scripts/cet-state.json`：干扰项、自动候选及补词历史。

## 使用

设置中填写私有仓库账号、仓库名及 token（仅授权所需私有数据仓库，Contents 读写），进度路径固定 `progress.json`。开启同步后点击“使用此数据仓库”。保存过的仓库可在下拉框切换，每个仓库的词库、进度、设置和离线缓存独立。

词库和进度首次联网同步后可离线学习；软件不会在公开站点提供默认词库。初次升级把旧本机进度复制到当时配置的数据仓库对应的存储键，原始旧键保留备份；未配置仓库的旧本机记录可先导出备份，再在对应仓库导入，不会自动塞入新词表。切换新词表时不会复制其他仓库的进度。不要清浏览器存储。

同步先验证仓库为私有并加载词库，再读取进度。逐词取较新 lastSeen 的阶段和 FSRS 卡；对错次数取较大值。读取失败停止上传，并发 409 重新合并，最多三轮。训练中的远端变化在本轮结束后合并，保留当前评分依据。

## 手动加词

从公开软件副本运行，目标为私有数据副本：

```bash
python3 scripts/add-words.py --repo /本地数据副本 --json-file /本批词.json --dry-run
python3 scripts/add-words.py --repo /本地数据副本 --json-file /本批词.json --no-commit
```

保留旧词 ID、内容和学习进度，指定词补“手动添加”标签。检查数据差异后发布私有仓库；用认证 API 回读验证，不发布私人数据到 Pages。详情见 [Agent Skill](../skills/worddrill-assistant/SKILL.md)。

## 自动补词

```bash
python3 scripts/add-cet-words.py --repo /本地数据副本 --data-repository owner/data-repo --dry-run
```

定时服务只给明确配置的数据仓库补词，从同一仓库读取 `progress.json`，只提交词库、候选及补词历史。期中等固定词表不配置自动补词服务。`meta.dailyWordTarget=80` 按今日已练、当前到期、未学词的不同词数补足；质量门槛、历史拒绝与学习进度保留。日程保持北京时间 06:00、Persistent=false，重启只待命。

## 迁移边界

先把原词库与辅助数据备份、复制到原私有仓库，独立核验 ID 和内容一致，再从公开主分支删除数据文件。历史 Git 提交仍可用于恢复；本次不重写历史。Service Worker 新版本只缓存软件资源，GitHub 私人文件只存本机对应仓库的存储键，不进入公共缓存。
