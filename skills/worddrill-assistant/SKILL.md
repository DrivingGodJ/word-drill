---
name: worddrill-assistant
description: 帮助 WordDrill 用户创建私有 GitHub 进度仓库、配置多设备同步，或将用户指定的英语单词加入其词库并发布核验。用于初始化同步、换设备与手动加词；不用于自动挑选四六级词或修改学习算法。
---

# WordDrill 助手

项目：[DrivingGodJ/word-drill](https://github.com/DrivingGodJ/word-drill)。按用户本次请求选择同步设置或手动加词；安装本 Skill 本身不授权创建仓库或发布词库。仅操作当前用户自己的账号、仓库和站点，不把项目作者的账号、服务器或个人目录当作默认目标。

## 创建进度仓库与配置同步

1. 使用当前环境的 GitHub 连接或 `gh`。先确认登录身份；未登录时引导用户完成登录，不索取密码。目标账号不明确时再询问。用户要求创建数据仓库时，可以直接执行以下流程。
2. 默认私有仓库名为 `worddrill-data`。先查仓库是否存在，已有仓库必须保留内容；若同名仓库是公开的，停止配置并请用户选择新的私有仓库名，不能上传学习记录。
3. 不存在时创建私有仓库并用 README 初始化。CLI 示例（`OWNER` 由实际登录身份替换）：

   ```bash
   gh api user --jq .login
   gh repo view OWNER/worddrill-data --json nameWithOwner,isPrivate,defaultBranchRef
   # 仅确认仓库不存在后运行；权限或网络错误不能当作不存在。
   gh repo create OWNER/worddrill-data --private --add-readme
   ```

4. 核验私有属性和 `main` 分支。本应用默认用 `main`。新仓库若只有其他初始分支，可从其当前提交创建 `main`；已有仓库若进度存在于其他分支，先说明情况，不能初始化空进度或覆盖记录。
5. 统一使用 **`progress.json`**。不要把仓库名填成文件路径，也不要另建 `progress.data`。若仓库已有进度，读取最新内容并验证 `words` 为对象；保留全部记录。新仓库不需要预写空进度，客户端首次成功同步会创建文件。若存在多份非空进度，先备份并使用项目的逐词合并逻辑，不选一个文件整包覆盖另一个。
6. 引导用户创建细粒度 GitHub token：仅授权这一个私有进度仓库，`Contents: Read and write`，设置合适有效期。GitHub 登录和个人 token 创建可能需用户完成；工具无法安全代办时停在这一步说明具体操作。已有有效 token 则复用。token 直接填入用户自己的 WordDrill 设置，不写进聊天、Skill、公开仓库、提交、日志或截图；GitHub CLI 的登录令牌不能直接当作浏览器专用 token。
7. 在实际使用的站点「设置 → 多设备同步」配置：

   | 字段 | 值 |
   | --- | --- |
   | 仓库所有者 | 已核验的用户账号 |
   | 私有仓库名 | `worddrill-data` 或本次选择的名称 |
   | 进度文件路径 | `progress.json` |
   | 访问令牌 | 用户为该仓库创建的 token |

   先在已有学习进度的设备导出本机备份，再开启同步，测试连接并立即同步；随后在其他设备填写完全相同的账号、仓库及路径。不开启清空进度，不清浏览器存储。
8. 验收不只看“同步成功”：核对两台设备的已学/已掌握数量与典型词的阶段，确认私有仓库实际更新的是 `main:progress.json`。空设备应先拉取再合并，不能直接 PUT 空记录。读取失败停止；并发更新使用最新文件 SHA 重读合并后重试，不能强制覆盖。远端数据不公开。

交付仓库链接、需要填的账号/仓库/路径及真实验收状态；若等待用户登录或填 token，明确剩余动作，不声称已完成双设备同步。

## 手动加入指定词

1. 确认用户当前使用的站点与其词库仓库。用户只使用作者公开站点且没有写权限时，说明个人词库需 fork 并部署自己的站点，或向作者提 PR；不把词写进私有进度文件，也不擅自改上游词库。沿用已有个人站点和仓库；新建 fork/站点按用户的授权范围进行。
2. 从目标仓库最新主分支取得完整、干净的工作副本，先读其 `AGENTS.md` 和 `scripts/add-words.py`。稀疏工作区缺脚本时可 `git show HEAD:scripts/add-words.py` 阅读；实际运行在完整检出中，因为脚本用自身路径定位数据。保留用户未提交工作，不在自动补词服务的运行目录里编辑。
3. 仅处理本次指定词表，清理重复与空白，核对拼写，不擅自改成另一词形。先查已有词；保留原 ID、内容及扩展字段。用可靠词典核验新词词性、释义和搭配，例句及译文须完整对应；项目自编例句不能冒称真题，不猜测考试标签。
4. 将 UTF-8 JSON 数组写入临时批次文件（下例仅说明结构，不能顺带加入示例词）：

   ```json
   [{"word":"resilient","pos":"adj.","meaning":"有韧性的；能迅速恢复的","example":"The team remained resilient after several difficult weeks.","exampleZh":"经历了数周的困难，团队依然坚韧。","collocations":["a resilient economy"],"tags":[]}]
   ```

5. 复用现有加词器，始终显式选择预演或只写文件模式：

   ```bash
   python3 scripts/add-words.py --json-file "$batch_file" --dry-run
   # 核对新增、已有、补手动标签和干扰池剔除项后：
   python3 scripts/add-words.py --json-file "$batch_file" --no-commit
   python3 scripts/check-cet.py
   node scripts/check-learning.cjs
   ```

   加词器默认模式会直接提交、推送并可能变基，不跳过预演走该路径。`id` 和 `手动添加` 标签由加词器处理；已存在的指定词也要补这个标签，六级词被手动指定后同样需认词和拼写。不同词头映射到同一 slug 时先解决冲突。
6. 核对全部原词与历史 ID 保留，已有指定词仅补手动标签；差异只限 `data/words.json` 及必要的 `data/distractors.json`。不碰学习进度、同步凭据、自动候选决定、`scripts/cet-state.json`、学习算法或定时器。重复批次应无新差异。
7. 按用户授权发布到其目标仓库与站点，遵守仓库流程。暂存明确文件，不夹带其他改动，不强推。远端前进时最多从最新主分支重新应用一次同批次并复验；认证、网络、保护规则失败则保留差异并说明。只要求预览时不发布。
8. 等待对应提交的学习检查和站点部署成功，再读取实际站点 `data/words.json?verify=提交SHA`，核对指定词、稳定 ID、手动标签及完整资料。数据更新无需清浏览器存储；不因加词改 service worker 版本。报告新增数、补标签数、已存在数、词典来源和真实发布状态。

Skill 安装方式由当前 Agent 环境决定。Codex 可使用其 skill-installer 从本仓库的 `skills/worddrill-assistant` 安装；其他支持 `SKILL.md` 的 Agent 安装同一目录，不支持安装时直接读取本文件。无需另装本项目作者的个人 Skill。
