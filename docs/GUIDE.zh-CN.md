**简体中文** | [English](GUIDE.en.md)

# 使用、配置与开发指南

[返回作品展示](../README.md)

## 快速开始

打开网站，在设置中连接包含词库的私有数据仓库后开始训练，建议添加到手机主屏幕以便离线使用。也可直接打开仓库中的 `index.html`；本地完整 PWA 体验需通过 localhost 或 HTTPS 托管。

先在设置中调整每日新词额度和记忆目标，再点“开始训练”。认词题先回想词义，再显示选项；选项可用 `1`–`4` 作答、`Enter` 继续。拼写默认隐藏首字母提示，答错后需订正。

## 使用说明

**学习规则**：FSRS-6 采用仓库内的 `ts-fsrs 5.4.2`，默认目标记忆率 90%，可调 80–95%；这是算法目标，不保证实际正确率。升关默认需 3 个不同日子的独立正确作答，并达到认词 7 天/拼写 21 天稳定性。这些是本站门槛，不是 FSRS 或 Anki 默认规则。

**每日备词**：当前词库 `meta.dailyWordTarget: 80` 启用北京时间 06:00 的服务器补词，按已练词、当前到期词与未学库存补足缺口；不是强制每天完成 80 词。资料不足会记录缺口，离线尚未同步的练习无法计入。旧候选模式与服务器配置见完整参考。

**多设备同步**：把词库（`data/words.json`）与进度（`progress.json`）放进同一个私有仓库，在各设备的设置中填写所有者、仓库、文件路径（默认 `progress.json`）及仅授权该仓库 Contents 读写的细粒度 token。token 只存当前浏览器 `localStorage`，仅发往 GitHub API；不得放进公开词库仓库。使用“测试连接”排查访问、分支与文件权限。

同步按词条最近练习时间合并；对错次数取较大值、不相加，学习设置取较新版本，发音保持设备独立。并发冲突会重读合并，最多 3 轮；两台完全离线的设备无法共享实时新词配额。

**进度保护**：学习记录仍使用 `worddrill.v1`，v6 迁移保留旧字段和 FSRS 状态，并先备份至 `worddrill.backup.before-v6`；旧 v5 备份也保留。损坏或更高版本数据不会直接覆盖。升级前导出进度，所有设备刷新后再同步。清除站点数据会清掉进度及 token；“清除凭据”只清当前设备的同步配置。

## 开发与验证

学习算法检查需要 **Node.js 20+**，无需安装依赖：

```bash
node scripts/check-learning.cjs
```

FlowUs 同步和手动加词使用 Python 3。先预览，不立即修改：

```bash
python3 scripts/sync-from-flowus.py --repo /本地数据副本 --dry-run
python3 scripts/add-words.py --repo /本地数据副本 --list words.txt --dry-run
python3 scripts/check-cet.py
```

加词脚本正式执行时可能自动提交并推送；只改文件用 `--no-commit`，具体操作先读完整参考。词条 `id` 必须稳定，修改等于新词。计时器、私有进度读取和发布密钥应独立配置，不能同时启用两套补词调度。

## 文档与支持

- [同步、迁移、词库、图标和定时补词完整参考](../docs/readme-reference.zh-CN.md)
- [学习研究、考试要求和证据边界](../docs/learning-upgrade.md)
- [问题反馈](https://github.com/DrivingGodJ/word-drill/issues)

## 许可与致谢

仓库未声明独立的整仓许可证。`vendor/` 中的 ts-fsrs 保留其 MIT 许可；词书、词频和例句等资料有各自来源，不应把依赖许可视作整仓或所有学习数据的授权。

数据仓库切换和迁移详见[完整参考](readme-reference.zh-CN.md)。各仓库学习进度与离线词库独立。
